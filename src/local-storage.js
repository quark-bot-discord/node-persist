/*
 * Simon Last, Sept 2013
 * http://simonlast.org
 */

var fs     = require('fs'),
    path   = require('path'),
    mkdirp = require('mkdirp'),
    Q      = require('q'),
    pkg    = require('../package.json'),

    defaults = {
        dir: '.' + pkg.name + '/storage',
        stringify: JSON.stringify,
        parse: JSON.parse,
        encoding: 'utf8',
        logging: false,
        continuous: true,
        interval: false,
        ttl: false
    },

    defaultTTL = 24 * 60 * 60 * 1000 /* ttl is truthy but not a number ? 24h default */,

    isNumber = function(n) {
        return !isNaN(parseFloat(n)) && isFinite(n);
    },

    isFunction = function(fn) {
        return typeof fn === 'function';
    },

    noop = function(err) {
        if (err) throw err;
    },

    btoa = function (string) {
        return new Buffer(string.toString(), 'binary').toString('base64');
    },

    atob = function (string) {
        return new Buffer(string, 'base64').toString('binary');
    },

    sanitize = function (string) {
        return btoa(string).replace(btoaPathSepRegExp, atobPathSepReplacement);
    },

    unsanitize = function (string) {
        return atob(string.replace(atobPathSepReplacementRegExp, '/'));
    },

    btoaPathSepRegExp = new RegExp(path.sep.replace('\\', '\\\\'), 'g'),

    atobPathSepReplacement = '__SLASH__',
    atobPathSepReplacementRegExp = new RegExp(atobPathSepReplacement, 'g'),

/*
 * To support backward compatible callbacks,
 * i.e callback(data) vs callback(err, data);
 * replace with noop and fix args order, when ready to break backward compatibily for the following API functions
 * - values()
 * - valuesWithKeyMatch()
 * hint: look for 'todo-breaks-backward' in the source
 */
    noopWithoutError = function() {};

var LocalStorage = function (userOptions) {
    if(!(this instanceof LocalStorage)) {
        return new LocalStorage(userOptions);
    }
    this.data = {};
    this.ttls = {};
    this.changes = {};
    this.setOptions(userOptions);

    // we don't call init in the constructor because we can only so for the initSync
    // for init async, it returns a promise, and in order to maintain that API, we cannot return the promise in the constructor
    // so init must be called on the instance of new LocalStorage();
};

LocalStorage.prototype = {

    setOptions: function (userOptions) {
        var options = {};

        if (!userOptions) {
            options = defaults;
        } else {
            for (var key in defaults) {
                if (userOptions.hasOwnProperty(key)) {
                    options[key] = userOptions[key];
                } else {
                    options[key] = defaults[key];
                }
            }

            // dir is not absolute
            options.dir = this.resolveDir(options.dir);
            options.ttlDir = options.dir + '-ttl';
            options.ttl = options.ttl ? isNumber(options.ttl) && options.ttl > 0 ? options.ttl : defaultTTL : false;
        }

        // Check to see if we received an external logging function
        if (isFunction(options.logging)) {
            // Overwrite log function with external logging function
            this.log = options.logging;
            options.logging = true;
        }

        this.options = options;
    },

    init: function (userOptions, callback) {
        if (isFunction(userOptions)) {
            callback = userOptions;
            userOptions = null;
        }
        if (userOptions) {
            this.setOptions(userOptions);
        }
        callback = isFunction(callback) ? callback : noop;

        var deferred = Q.defer();
        var deferreds = [];

        var options = this.options;

        var result = {dir: options.dir};
        deferreds.push(this.parseDataDir());

        if (options.ttl) {
            result.ttlDir = options.ttlDir;
            deferreds.push(this.parseTTLDir());
        }

        //start persisting
        if (options.interval && options.interval > 0) {
            this._persistInterval = setInterval(this.persist.bind(this), options.interval);
        }

        Q.all(deferreds).then(
            function() {
                deferred.resolve(result);
                callback(null, result);
            },
            function(err) {
                deferred.reject(err);
                callback(err);
            });

        return deferred.promise;
    },

    initSync: function (userOptions) {
        if (userOptions) {
            this.setOptions(userOptions);
        }

        var options = this.options;

        if (options.logging) {
            this.log("options:");
            this.log(options.stringify(options));
        }

        this.parseDataDirSync();

        if (options.ttl) {
            this.parseTTLDirSync();
        }

        //start synchronous persisting,
        if (options.interval && options.interval > 0) {
            this._persistInterval = setInterval(this.persistSync.bind(this), options.interval);
        }
    },

    keys: function () {
        return Object.keys(this.data);
    },

    length: function () {
        return this.keys().length;
    },

    forEach: function(callback) {
        return this.keys().forEach(function(key) {
            callback(key, this.data[key]);
        }.bind(this));
    },

    values: function() {
        return this.keys().map(function(k) {
            return this.data[k];
        }.bind(this));
    },


    valuesWithKeyMatch: function(match) {
        match = match || /.*/;

        var filter = match instanceof RegExp ?
            function(key) {
                return match.test(key);
            } :
            function(key) {
                return key.indexOf(match) !== -1;
            };

        var values = [];
        this.keys().forEach(function(k) {
            if (filter(k)) {
                values.push(this.data[k]);
            }
        }.bind(this));

        return values;
    },

    set: function () {
        return this.setItem(key, value, callback);
    },

    setItem: function (key, value, callback) {
        callback = isFunction(callback) ? callback : noop;

        var options = this.options;
        var result;
        var logmsg = "set (" + key + ": " + options.stringify(value) + ")";

        var deferred = Q.defer();
        var deferreds = [];

        this.data[key] = value;
        if (options.ttl) {
            this.ttls[key] = new Date().getTime() + options.ttl;
        }

        result = {key: key, value: value, queued: !!options.interval, manual: !options.interval && !options.continuous};

        var onSuccess = function () {
            callback(null, result);
            deferred.resolve(result);
        };

        var onError = function (err) {
            callback(err);
            deferred.reject(err);
        };

        this.log(logmsg);

        if (options.interval || !options.continuous) {
            this.changes[key] = {onSuccess: onSuccess, onError: onError};
        } else {
            deferreds.push(this.persistKey(key));

            Q.all(deferreds).then(
                function(result) {
                    deferred.resolve(result);
                    callback(null, result);
                }.bind(this),
                function(err) {
                    deferred.reject(err);
                    callback(err);
                });
        }

        return deferred.promise;
    },

    setItemSync: function (key, value) {
        this.data[key] = value;
        if (this.options.ttl) {
            this.ttls[key] = new Date().getTime() + this.options.ttl;
        }
        this.persistKeySync(key);
        this.log("set (" + key + ": " + this.options.stringify(value) + ")");
    },

    get: function (key, callback) {
        return this.getItem(key, callback);
    },

    getItem: function (key, callback) {
        callback = isFunction(callback) ? callback : noop;
        var deferred = Q.defer();

        if (this.isExpired(key)) {
            this.log(key + ' has expired');
            if (this.options.interval || !this.options.continuous) {
                callback(null, null);
                return deferred.resolve(null);
            }
            return this.removeItem(key).then(function() {
                return null;
            });
        } else {
            callback(null, this.data[key]);
            deferred.resolve(this.data[key]);
        }
        return deferred.promise;
    },

    getItemSync: function (key) {
        if (this.isExpired(key)) {
            this.removeItemSync(key);
        } else {
            return this.data[key];
        }
    },

    del: function (key, callback) {
        return this.removeItem(key, callback);
    },

    rm: function (key, callback) {
        return this.removeItem(key, callback);
    },

    removeItem: function (key, callback) {
        callback = isFunction(callback) ? callback : noop;

        var deferred = Q.defer();
        var deferreds = [];

        deferreds.push(this.removePersistedKey(key));

        Q.all(deferreds).then(
            function() {
                delete this.data[key];
                delete this.ttls[key];
                this.log('removed: ' + key);
                callback(null, this.data);
                deferred.resolve(this.data);
            }.bind(this),
            function(err) {
                callback(err);
                deferred.reject(err);
            }
        );

        return deferred.promise;
    },

    removeItemSync: function (key) {
        this.removePersistedKeySync(key);
        delete this.data[key];
        delete this.ttls[key];
        this.log('removed: ' + key);
    },

    clear: function (callback) {
        callback = isFunction(callback) ? callback : noop;

        var deferred = Q.defer();
        var result;
        var deferreds = [];

        var keys = this.keys();
        for (var i = 0; i < keys.length; i++) {
            deferreds.push(this.removePersistedKey(keys[i]));
        }

        Q.all(deferreds).then(
            function(result) {
                this.data = {};
                this.ttls = {};
                this.changes = {};
                deferred.resolve(result);
                callback(null, result);
            }.bind(this),
            function(err) {
                deferred.reject(err);
                callback(err);
            });

        return deferred.promise;
    },

    clearSync: function () {
        var keys = this.keys(true);
        for (var i = 0; i < keys.length; i++) {
            this.removePersistedKeySync(keys[i]);
        }
        this.data = {};
        this.ttls = {};
        this.changes = {};
    },

    persist: function (callback) {
        callback = isFunction(callback) ? callback : noop;

        var deferred = Q.defer();
        var result;
        var deferreds = [];

        for (var key in this.data) {
            if (this.changes[key]) {
                deferreds.push(this.persistKey(key));
            }
        }

        Q.all(deferreds).then(
            function(result) {
                deferred.resolve(result);
                callback(null, result);
                this.log('persist done');
            }.bind(this),
            function(err) {
                deferred.reject(result);
                callback(err);
            });

        return deferred.promise;
    },

    persistSync: function () {
        for (var key in this.data) {
            if (this.changes[key]) {
                this.persistKeySync(key);
            }
        }
        this.log('persistSync done');
    },

    /*
     * This function triggers a key within the database to persist asynchronously.
     */
    persistKey: function (key, callback) {
        callback = isFunction(callback) ? callback : noop;

        var self = this;
        var options = this.options;
        var json = options.stringify(this.data[key]);

        var file = path.join(options.dir, sanitize(key));

        var ttlFile;

        var deferred = Q.defer();
        var result;

        var fail = function(err) {
            self.changes[key] && self.changes[key].onError && self.changes[key].onError(err);
            deferred.reject(err);
            return callback(err);
        };

        var done = function() {
            self.changes[key] && self.changes[key].onSuccess && self.changes[key].onSuccess();
            delete self.changes[key];
            self.log("wrote: " + key);
            result = {key: key, data: json, file: file};
            deferred.resolve(result);
            callback(null, result);
        };

        mkdirp(path.dirname(file), function(err) {
            if (err) {
                fail(err);
            }
            fs.writeFile(file, json, options.encoding, function(err) {
                if (err) {
                    fail(err);
                }
                if (options.ttl) {
                    ttlFile = path.join(options.ttlDir, sanitize(key));
                    mkdirp(path.dirname(ttlFile), function(err) {
                        fs.writeFile(ttlFile, options.stringify(self.ttls[key]), options.encoding, function() {
                            if (err) {
                                fail(err);
                            } else {
                                done();
                            }
                        });
                    });
                } else {
                    done();
                }
            }.bind(this));
        });

        return deferred.promise;
    },

    persistKeySync: function (key) {
        var options = this.options;
        var file = path.join(options.dir, sanitize(key));
        try {
            mkdirp.sync(path.dirname(file));
            fs.writeFileSync(file, options.stringify(this.data[key]));
            this.changes[key] && this.changes[key].onSuccess && this.changes[key].onSuccess();
        } catch (e) {
            this.changes[key] && this.changes[key].onError && this.changes[key].onError(e);
            throw e;
        }

        var ttlFile;
        if (options.ttl) {
            ttlFile = path.join(options.ttlDir, sanitize(key));
            mkdirp.sync(path.dirname(ttlFile));
            fs.writeFileSync(ttlFile, options.stringify(this.ttls[key]));
        }

        delete this.changes[key];
        this.log("wrote: " + key);
    },

    removePersistedKey: function (key, callback) {
        callback = isFunction(callback) ? callback : noop;

        var options = this.options;
        var deferred = Q.defer();
        var result;

        //check to see if key has been persisted
        var file = path.join(options.dir, sanitize(key));
        fs.exists(file, function (exists) {
            if (exists) {
                fs.unlink(file, function (err) {
                    result = {key: key, removed: !err, exists: true};

                    var fail = function(err) {
                        deferred.reject(err);
                        callback(err);
                    };

                    var done = function() {
                        deferred.resolve(result);
                        callback(null, result);
                    };

                    if (err) {
                        return fail(err);
                    }

                    if (options.ttl) {
                        var ttlFile = path.join(options.ttlDir, sanitize(key));
                        fs.exists(ttlFile, function (exists) {
                            if (exists) {
                                fs.unlink(ttlFile, function (err) {
                                    if (err) {
                                        fail(err);
                                    }
                                    done();
                                });
                            } else {
                                done();
                            }
                        });
                    } else {
                        done();
                    }
                });
            } else {
                result = {key: key, removed: false, exists: false};
                deferred.resolve(result);
                callback(null, result);
            }
        });

        return deferred.promise;
    },

    parseString: function(str){
        try {
            return this.options.parse(str);
        } catch(e) {
            this.log("parse error: ", this.options.stringify(e));
            return undefined;
        }
    },

    parseTTLDir: function(callback) {
        return this.parseDir(this.options.ttlDir, this.parseTTLFile.bind(this), callback);
    },

    parseTTLDirSync: function() {
        return this.parseDirSync(this.options.ttlDir, this.ttls);
    },

    parseDataDir: function(callback) {
        return this.parseDir(this.options.dir, this.parseDataFile.bind(this), callback);
    },

    parseDataDirSync: function() {
        return this.parseDirSync(this.options.dir, this.data);
    },

    parseDir: function(dir, parseFn, callback) {
        callback = isFunction(callback) ? callback : noop;

        var deferred = Q.defer();
        var deferreds = [];

        var result = {dir: dir};
        //check to see if dir is present
        fs.exists(dir, function (exists) {
            if (exists) {
                //load data
                fs.readdir(dir, function (err, arr) {
                    if (err) {
                        deferred.reject(err);
                        callback(err);
                    }

                    for (var i in arr) {
                        var curr = arr[i];
                        if (curr[0] !== '.') {
                            deferreds.push(parseFn(unsanitize(curr)));
                        }
                    }

                    Q.all(deferreds).then(
                        function() {
                            deferred.resolve(result);
                            callback(null, result);
                        },
                        function(err) {
                            deferred.reject(err);
                            callback(err);
                        });

                }.bind(this));
            } else {
                //create the directory
                mkdirp(dir, function (err) {
                    if (err) {
                        console.error(err);
                        deferred.reject(err);
                        callback(err);
                    } else {
                        this.log('created ' + dir);
                        deferred.resolve(result);
                        callback(null, result);
                    }
                }.bind(this));
            }
        }.bind(this));

        return deferred.promise;
    },

    parseDirSync: function(dir, hash) {
        var exists = fs.existsSync(dir);

        if (exists) { //load data
            var arr = fs.readdirSync(dir);
            for (var i = 0; i < arr.length; i++) {
                var curr = arr[i];
                if (arr[i] && curr[0] !== '.') {
                    var json = fs.readFileSync(path.join(dir, curr), this.options.encoding);
                    hash[unsanitize(curr)] = this.parseString(json);
                }
            }
        } else { //create the directory
            mkdirp.sync(dir);
        }
    },

    parseDataFile: function(key, callback) {
        return this.parseFile(key, this.options.dir, this.data, callback);
    },

    parseDataFileSync: function(key) {
        return this.parseFileSync(key, this.options.dir, this.data);
    },

    parseTTLFile : function(key, callback) {
        return this.parseFile(key, this.options.ttlDir, this.ttls, callback);
    },

    parseTTLFileSync: function(key) {
        return this.parseFileSync(key, this.options.ttlDir, this.ttls);
    },

    parseFile: function (key, dir, hash, callback) {
        callback = isFunction(callback) ? callback : noop;

        var deferred = Q.defer();
        var result;
        var file = path.join(dir, sanitize(key));
        var options = this.options;

        fs.readFile(file, options.encoding, function (err, json) {
            if (err) {
                deferred.reject(err);
                return callback(err);
            }

            var value = this.parseString(json);

            hash[key] = value;

            this.log("loaded: " + dir + "/" + key);

            result = {key: key, value: value, file: file};
            deferred.resolve(result);
            callback(null, result);

        }.bind(this));

        return deferred.promise;
    },

    parseFileSync: function(key, dir, hash) {
        var file = path.join(dir, sanitize(key));
        hash[key] = fs.readFileSync(file, this.options.encoding);
        this.log("loaded: " + dir + "/" + key);
        return hash[key];
    },

    isExpired: function (key) {
        if (!this.options.ttl) return false;
        return this.ttls[key] < (new Date()).getTime();
    },

    removePersistedKeySync: function(key) {
        var options = this.options;

        var file = path.join(options.dir, sanitize(key));
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
        if (options.ttl) {
            var ttlFile = path.join(options.ttlDir, sanitize(key));
            if (fs.existsSync(ttlFile)) {
                fs.unlinkSync(ttlFile);
            }
        }
    },

    resolveDir: function(dir) {
        dir = path.normalize(dir);
        if (path.isAbsolute(dir)) {
            return dir;
        }
        return path.join(process.cwd(), dir);
    },

    stopInterval: function () {
        clearInterval(this._persistInterval);
    },

    log: function () {
        this.options && this.options.logging && console.log.apply(console, arguments);
    },

    sanitize: sanitize,
    unsanitize: unsanitize
};

module.exports = LocalStorage;
/*
 * (C) Copyright 2017 o2r project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

const config = require('./config/config');
const mapping = require('./esconfig/mapping');
const debug = require('debug')('finder');

// MongoDB > Elasticsearch sync
const ESMongoSync = require('node-elasticsearch-sync');

// standalone Elasticsearch client
const elasticsearch = require('elasticsearch');
const esclient = new elasticsearch.Client({
  host: config.elasticsearch.location,
  log: 'info'
});

const fs = require('fs');
const dirTree = require('directory-tree');
const rewriteTree = require('./lib/tree').rewriteTree;
const readTextfileTree = require('./lib/tree').readTextfileTree;
const flattenTree = require('./lib/tree').flattenTree;
const mimeTree = require('./lib/tree').mimeTree;
const cloneDeep = require('clone-deep');

// database connection for user authentication, ESMongoSync has own connection
const mongoose = require('mongoose');
mongoose.connect(config.mongo.userDatabase);
mongoose.connection.on('error', () => {
  debug('ERROR could not connect to mongodb on ' + config.mongo.location + config.mongo.collection + ', ABORT');
  process.exit(1);
});

// rolling queue of the last n transformations
const CircularBuffer = require('circular-buffer');
const transformLog = new CircularBuffer(config.sync.logsize);
debug('Logging last %s transformations in %s', transformLog.capacity(), transformLog);

// Express modules and tools
const compression = require('compression');
const express = require('express');
const app = express();
app.use(compression());

app.use((req, res, next) => {
  debug(req.method + ' ' + req.path);
  next();
});

// passport & session modules for authenticating users.
const User = require('./lib/model/user');
const passport = require('passport');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);

passport.serializeUser((user, cb) => {
  cb(null, user.orcid);
});
passport.deserializeUser((id, cb) => {
  debug('Deserialize for %s', id);
  User.findOne({ orcid: id }, (err, user) => {
    if (err) cb(err);
    cb(null, user);
  });
});

// configure express-session, stores reference to authdetails in cookie.
// authdetails themselves are stored in MongoDBStore
const mongoStore = new MongoDBStore({
  uri: config.mongo.location + config.mongo.database,
  collection: config.mongo.collection.session
});
mongoStore.on('error', err => {
  debug(err);
});

app.use(session({
  secret: config.sessionsecret,
  resave: true,
  saveUninitialized: true,
  maxAge: config.session.cookieMaxAge,
  store: mongoStore
}));
app.use(passport.initialize());
app.use(passport.session());

/*
 * authentication-enabled status endpoint
 */
app.get('/status', function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!req.isAuthenticated() || req.user.level < config.user.level.view_status) {
    res.status(401).send('{"error":"not authenticated or not allowed"}');
    return;
  }

  let response = {
    name: 'finder',
    version: config.version,
    levels: config.user.level,
    mongodb: config.mongo,
    filesystem: config.fs,
    transformationLog: transformLog.toarray()
  };

  // add status info from elasticsearch to response
  Promise.all([
    esclient.indices.stats({ human: true }),
    esclient.info()
  ]).then(values => {
    response.elasticsearch = {};
    response.elasticsearch.status = values[1];
    response.elasticsearch.indices = values[0].indices;
    res.send(response);
  }, error => {
    debug('Error getting info from Elasticsearch: %s', error.message);
    response.elasticsearch = error;
  }).catch(error => {
    debug('Error handling promises\' results from Elasticsearch: %s', error.message);
    res.send(response);
  });
});

// transform functions for node-elasticsearch-sync
const transformCompendium = function (watcher, compendium, cb) {
  let id = compendium.id;
  debug('Transforming compendium %s', id);

  try {
    // shift IDs so that matching is made based on Mongo's _id
    compendium.compendium_id = compendium.id;
    compendium.id = compendium._id.toString(); // see https://github.com/toystars/node-elasticsearch-sync/issues/13
    delete compendium._id;
    delete compendium.__v;

    // load file tree
    let tree = null;
    fs.accessSync(config.fs.compendium + id); // throws if does not exist
    tree = dirTree(config.fs.compendium + id);

    // create file tree for metadata
    if (tree) {
      // rewrite copy of tree to API urls, taken from o2r-muncher
      let apiTree = rewriteTree(cloneDeep(tree),
        config.fs.compendium.length + config.id_length, // remove local fs path and id
        '/api/v1/compendium/' + id + '/data' // prepend proper location
      );
      compendium.files = apiTree;
    }

    // load content of txt files as flat list
    if (tree) {
      let textTree = mimeTree(cloneDeep(tree));
      readTextfileTree(textTree);
      let list = [];
      flattenTree(textTree,
        config.fs.compendium.length + config.id_length + 1, // make path relative to compendium root
        list);
      compendium.texts = list;
    }

    // attach binary files as base64
    // > https://www.elastic.co/guide/en/elasticsearch/plugins/current/mapper-attachments-usage.html
    // > as nested documents to have many
    //   > http://grokbase.com/t/gg/elasticsearch/148v29ymaf/how-can-we-index-array-of-attachments
    //   > https://www.elastic.co/guide/en/elasticsearch/reference/current/nested.html

    transformLog.enq({ time: new Date().toISOString(), compendium: id, transform: 'successful' });
    debug('Transformed compendium %s', id);
    cb(compendium);
  } catch (e) {
    transformLog.enq({ time: new Date().toISOString(), compendium: id, transform: 'error: ' + e.message });
    debug('Error while transforming %s : %s', id, e.message);
    cb(null);
  }
};

const transformJob = function (watcher, job, cb) {
  debug('Transforming job %s', job.id);

  // shift IDs
  job.job_id = job.id;
  job.id = job._id;
  delete job._id;
  delete job.__v;

  debug('Transformed job %s', job.id);
  cb(job);
};

// watchers for node-elasticsearch-sync
const watchers = [];
const compendiaWatcher = {
  collectionName: config.mongo.collection.compendia,
  index: config.elasticsearch.index, // elastic search index
  type: config.elasticsearch.type.compendia, // elastic search type
  transformFunction: transformCompendium, // can be null if no transformation is needed to be done
  fetchExistingDocuments: config.sync.fetchExisting.compendia, // this will fetch all existing document in collection and index in elastic search
  priority: 1 // defines order of watcher processing. Watchers with low priorities get processed ahead of those with high priorities
};
const jobsWatcher = {
  collectionName: config.mongo.collection.jobs,
  index: config.elasticsearch.index,
  type: config.elasticsearch.type.jobs,
  transformFunction: transformJob,
  fetchExistingDocuments: config.sync.fetchExisting.jobs,
  priority: 10
};

watchers.push(compendiaWatcher, jobsWatcher);

// http://stackoverflow.com/questions/951021/what-is-the-javascript-version-of-sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let attempts = 1;

function startSyncWithRetry(watcherArray, maximumNumberOfAttempts, pauseSeconds) {
  if (attempts > maximumNumberOfAttempts) {
    debug('NOT STARTED, number of attempts to connect to Elasticsearch at %s (%s) has been reached.', process.env['ELASTIC_SEARCH_URL'], maximumNumberOfAttempts);

    process.exit(1);
  }

  // try to connect to ES before starting sync
  let EsClient = new elasticsearch.Client({
    host: process.env['ELASTIC_SEARCH_URL'],
    keepAlive: true
  });
  debug('Ping Elasticsearch @ %s', process.env['ELASTIC_SEARCH_URL']);
  EsClient.ping({
    requestTimeout: 2000
  }, function (error, response, status) {
    if (error) {
      debug('ElasticSearch no reachable, trying again in %s seconds', pauseSeconds);
      attempts++;
      sleep(pauseSeconds * 1000).then(() => {
        startSyncWithRetry(watchers, maximumNumberOfAttempts, pauseSeconds);
      });
    } else {
      debug('Pinged ElasticSearch at %s with result %s (status %s)', process.env['ELASTIC_SEARCH_URL'], response, status);

      // See https://github.com/toystars/node-elasticsearch-sync/blob/master/SAMPLE.js for options
      // See also https://github.com/toystars/node-elasticsearch-sync/issues/10
      debug('Starting ESMongoSync with mongo data "%s" | mongo oplog "%s" | elasticsearch "%s" | batch count "%s" | watchers: \n',
        process.env['MONGO_DATA_URL'],
        process.env['MONGO_OPLOG_URL'],
        process.env['ELASTIC_SEARCH_URL'],
        process.env['BATCH_COUNT'],
        JSON.stringify(watchers));
      ESMongoSync.init(watcherArray, null, () => {
        debug('ESMongoSync initialized');
      });
    }
  });

}

app.listen(config.net.port, () => {

  // delete existing index and create new index with spatial mapping
  esclient.indices.exists({ index: config.elasticsearch.index })
  .then(function (resp) {
    // delete possibly existing index if deleteIndexOnStartup is true
    if (resp && config.elasticsearch.deleteIndexOnStartup) {
      debug('Index %s already exists: %s', config.elasticsearch.index, resp);
      return esclient.indices.delete({ index: config.elasticsearch.index });
    } else {
      return resp;
    }
  }).then(function (resp) {
    debug('Existing index deleted: %s', JSON.stringify(resp));

    // create a new index if: 1) index was deleted in the last step 2) index didn't exist in the beginning
    if (typeof resp === 'object' && resp.acknowledged) {
      return esclient.indices.create({ index: config.elasticsearch.index });
    } else if (!resp) {
      return esclient.indices.create({ index: config.elasticsearch.index });
    } else {
      return false;
    }
  }).then(function (resp) {
    debug('Index (re)created: %s', JSON.stringify(resp));
    if (config.elasticsearch.putMappingOnStartup) {
      return esclient.indices.putMapping({ index: config.elasticsearch.index, type: config.elasticsearch.type.compendia, body: mapping });
    } else {
      return false;
    }
  }).then(function (resp) {
    debug('Successfully created elasticsearch index and mapping. Mapping response: %s', JSON.stringify(resp));
    startSyncWithRetry(watchers, config.start.attempts, config.start.pauseSeconds);

    debug('finder %s with API version %s waiting for requests on port %s',
        config.version,
        config.api_version,
        config.net.port);
  }).catch(function (err) {
    debug('Error creating index: %s', err);
  });
});


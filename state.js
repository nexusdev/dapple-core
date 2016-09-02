'use strict';
var levelup = require('levelup');
var userHome = require('user-home');
var path = require('path');
// TODO - make dappleChain loading asynchronous or initialize it back with a callback
var DappleChain = require('dapple-chain/lib/blockchain.js');
var DapphubInterface = require('dapple-chain/lib/dapphubInterface.js');
var chain = require('dapple-chain');
var async = require('async');
var fs = require('./file.js');
var exporter = require('./export.js');
var _ = require('lodash');
var Web3 = require('web3');
var migrate = require('./migrate.js');

class State {
  constructor(cliSpec, cb) {
    if(State.singleton) return State.singleton;
    State.singleton = this;
    this.modules = {};
    this.cliSpec = cliSpec;
    // Setup dapple if this is the first run
  }

  initWorkspace( workspace, callback ) {
    var initGlobalDb = levelup.bind(this, path.join(userHome, '.dapple'));
    var initGlobalState = (cb) => {
      this._global_state = {
        networks: {},
        state: {}
      };
      if(!fs.existsSync(path.join(userHome, '.dapple', 'config'))) {
        fs.mkdirp(path.join(userHome, '.dapple'));
        fs.writeFileSync(path.join(userHome, '.dapple', 'config'), JSON.stringify(this._global_state, false, 2));
      } else {
        this._global_state = JSON.parse(fs.readFileSync(path.join(userHome, '.dapple', 'config')));
      }
      cb();
    };
    var initLocalDb = this.initLocalDb.bind(this, workspace.package_root);
    async.waterfall([
      // initGlobalDb,
      initGlobalState,
      initLocalDb
    ], (err) => {
      if(err) throw new Error(err);
      this.workspace = workspace;
      this.initEnvironments(workspace.dappfile.environments);
      callback();
    });
  }

  initEnvironments (environments) {
    _.each(environments, (env, name) => {
      if(name in this.state.pointers) {
        this.state.pointers[name].env = env.objects;
      } else {
        this.state.pointers[name] = {env: env.objects, type: "UNKNOWN"};
        console.log(`WARN: you seem to have no chain named ${name}!`);
      }
    });
  }

  initLocalDb(package_root, cb) {
    let localdbPath = path.join(package_root,'.dapple/chain_db');

    if(!fs.existsSync(path.join(package_root, '.dapple'))) {
      fs.mkdirp(path.join(package_root, '.dapple'));
    }
    var handleState = (cb, err, state) => {
      if(err && err.type === 'NotFoundError') {
        this.createState();
      } else {
        this.state = state;
      }
      var chainenv = this.state.pointers[this.state.head];
      cb(null, chainenv);
    }

    async.waterfall([
      levelup.bind(this, localdbPath),
      (db, cb) => { this.db = db; cb(null, db); },
      (db, cb) => { db.get('state', {valueEncoding: 'json'}, handleState.bind(this, cb)) }
    ], (err, chainenv) => {
      if(err) throw err;

      if( chainenv.type === 'internal' ) {
        this.initChain(chainenv);
      }
      cb( null, this);
    });
  }

  initChain (chainenv) {
    this.chain = new DappleChain({
      db: this.db,
      chainenv
    });
  }

  exportEnvironment () {
    exporter.environment(this);
  }

  saveState(persistent) {
    // TODO - async
    if(this.mode === 'persistent' || persistent) {
      if(this.workspace) {
        this.workspace.dappfile.environments =
          _.mapValues(this.state.pointers, p => ({objects: p.env||{}, type: p.type}) );
        this.workspace.writeDappfile();
      }
      this.db.put('state', this.state, {valueEncoding: 'json'});
    }
  }

  createState () {
    this.state = { pointers: {} };
    this.createChain("master");
  }

  // TODO - refactor this to chain?
  createChain (name) {
    var chainenv = chain.initNew(this.db);
    this.state.head = name;
    this.state.pointers[name] = chainenv;
    this.saveState(true);
  }

  // TODO - diferentiate on chain type - refactr dhInterface
  forkLiveChain (name, type, callback) {
    var dhInterface;
    if(!this.chain) {
      dhInterface = new DapphubInterface();
      dhInterface.initDb(this.db);
    } else {
      dhInterface = this.chain.dhInterface;
    }
    dhInterface.forkLatest(type, callback);
  }

  // Returns a json object out of the global database
  getJSON(key, cb) {
    cb(null, this._global_state[key]);
    // this.globalDb.get(key, {valueEncoding: 'json'}, cb);
  }

  registerModule(module) {
    this.modules[module.name] = module;
    let prefixedCommands = module.cliSpec.commands.map(cmd => {
      if(module.name != 'core' && module.name != cmd.name) {
        cmd.name = module.name + ' ' + cmd.name;
      }
      return cmd;
    });
    // add command line operations to dapples cli
    this.cliSpec.commands = this.cliSpec.commands.concat(prefixedCommands);
  }

  addNetwork(obj, cb) {
    this._global_state.networks[obj.name] = obj.chainenv;
    fs.writeFileSync(path.join(userHome, '.dapple', 'config'), JSON.stringify(this._global_state, false, 2));
  }

  getRemoteWeb3(type, callback) {

    // See if the chain is online
    function pingChain(chainenv, cb) {
      var web3 = new Web3(new Web3.providers.HttpProvider(`http://${chainenv.network.host}:${chainenv.network.port}`));
      if(web3.isConnected()) {cb(null, web3, chainenv)}
    }
    // see if the defaultAccount has enough balance to proceed the transaction
    function getBalance(web3, chainenv, cb) {cb(null, web3, chainenv);}
    // see if the defaultAccount is actually unlocked
    function testUnlocked(web3, chainenv, cb) {cb(null, web3, chainenv);}

    // go and get all chains of the desired type:
    var filterType = chainenv => chainenv.type === type;
    // build tasklist - try to find an accessable chain
    var candidates = _.filter(this.state.pointers, filterType)
    .map(chainenv => async.waterfall.bind(async, [
      pingChain.bind(this, chainenv),
      getBalance,
      testUnlocked
    ]));

    // as fast as it can
    async.race(candidates, callback);
  }

  migrate() {
    migrate.handler(this);
  }


}
State.singleton = null;

module.exports = State;

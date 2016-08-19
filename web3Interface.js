'use strict';

// TODO - refactor this, maybe with promisses the structure gets simpler

var Web3Factory = require('./web3Factory.js');
var deasync = require('deasync');
var chain = require('dapple-chain');
var createNewChain = require('dapple-chain/lib/createNewChain.js');
var chain_expert = require('dapple-chain/lib/chain_expert.js');
var levelup = require('levelup');
var memdown = require('memdown');
var async = require('async');

const DEFAULT_GAS = 3141592;

// TODO - refactor this to pure chainenv
class Web3Interface {

  constructor (opts, web3) {
    this._gas = DEFAULT_GAS;
    this.chainenv = opts.chainenv;
    this.filterCallbacks = [];
    this.supervisor = opts.supervisor;

    if (web3) {
      this._web3 = web3;
    } else if (opts.chainenv.type === 'internal') {
      Web3Factory.EVM(opts, (err, web3) => {
        if (err) throw new Error(err);
        this._web3 = web3;
      });
    } else if (opts.type === 'tmp') {
      // TODO - in memory database has problems with dapplechain.runBlock
      // var db = levelup('/tmp', { db: require('memdown') }, (err, db) => {
      // opts.db = opts.db;
      var chainenv;
      var addr = opts.chainenv.defaultAccount;
      var type = opts.chainenv.type;

      if(type === 'MORDEN' || type === 'ETH' || type === 'ETC') {
        chainenv = deasync(chain.forkLiveChain.bind(opts.state))(opts.state.db, type);
        chainenv.defaultAccount = addr;
        chainenv.fakedOwnership.push(addr);
      } else {
        chainenv = chain.initNew(opts.db);
      }
      this.chainenv = opts.chainenv = chainenv;

      Web3Factory.EVM(opts, (err, web3) => {
        if (err) throw new Error(err);
        this._web3 = web3;
      });
    } else {
      this._web3 = Web3Factory.JSONRPC(opts);
      var block = this._web3.eth.getBlock('latest');
      this._gas = block.gasLimit;
    }
    deasync.loopWhile(() => { return typeof this._web3 !== 'object'; });
    this._web3.eth.getBlock(0, (err, res) => {
      if (err) throw new Error(err);
      this._block0 = res;
    });
    // this._tasks = {};
  }

  // returns an address of a deployed contract given a transaction hash
  getDeployReceiptSync (txHash) {
    var self = this;
    var fSync = deasync(function (cb) {
      self._web3.eth.getTransactionReceipt(txHash, function (err, receipt) {
        if (err) {
          cb(err);
        }
        if (!receipt || !receipt.contractAddress) return null;
        cb(null, receipt);
      });
    });
    return fSync();
  }

  waitForBlock (blockNumber, cb) {
    var self = this;
    var watch = (err, result) => {
      if (err) {
        this.removeOnBlock(watch);
        return cb(err);
      }
      self._web3.eth.getBlockNumber((err, currentBlockNumber) => {
        if( currentBlockNumber >= blockNumber ) {
          this.removeOnBlock(watch);
          return cb();
        } else {
          this.setStatus(`waiting ${blockNumber - currentBlockNumber} blocks`);
        }
      });
    };
    this.onBlock(watch);
  }

  getCode (address) {
    var self = this;
    var fSync = deasync(function (cb) {
      self._web3.eth.getCode(address, function (err, res) {
        if (err) {
          return cb(err);
        }
        cb(null, res);
      });
    });
    var code = fSync();
    return code;
  }

  confirmCode (address) {
    var code = this.getCode(address);

    if (typeof code === 'string' && code.length > 2) {
      return true;
    }
    throw new Error('could not verify contract');
  }

  // deploys a contract async
  //
  // opts.abi:  aplication binary interface
  // opts.bytecode : contract bytecode
  // opts.className: Class Name
  // opts.args: constructor args
  //
  deploy (opts) {
    // TODO - check wih json schema
    var Class = this._web3.eth.contract(opts.abi);
    // Concates the constructor arguments to the binary data for the deploy
    // TODO - test with atoms
    // TODO - refactor the arg mapping outside of deploy
    var args = opts.args.concat([ { data: opts.bytecode } ]);
    // TODO - typecheck parametery against the abi
    var data = Class.new.getData.apply(this, args);
    var address = this._web3.eth.defaultAccount;
    var receipt;
    var txHash;
    var self = this;
    var _filter = this._web3.eth.filter('latest', function (err, result) {
      if (err) throw err;
      if (!txHash) return null;
      // var _receipt = self.getDeployReceiptSync( txHash );
      self._web3.eth.getTransactionReceipt(txHash, function (err, _receipt) {
        if (err) {
          _filter.stopWatching();
          throw err;
        }
        if (!_receipt || !_receipt.contractAddress) return null;
        _filter.stopWatching();
        self._web3.eth.getCode(_receipt.contractAddress, (err, code) => {
          if (err) throw new Error(err);
          if (/^0x0*$/.test(code)) {
            throw new Error(`Could not deploy contract ${opts.className}. ` +
                            `Transaction went through, but there is no code ` +
                            `at contract address ${_receipt.contractAddress}`);
          }
          receipt = _receipt;
        });
      });
    });
    // TODO - hack
    address = this._web3.eth.coinbase;
    this._web3.eth.sendTransaction({
      from: address,
      data: data,
      gas: opts.gas || this._gas
    // gas: 895807
    }, function (err, _txHash) {
      if (err) {
        _filter.stopWatching();
        throw err;
      }
      // Check if the transaction got rejected
      if ((/^0x0*$/).test(_txHash)) {
        _filter.stopWatching();
        throw new Error(`Could not deploy contract ${opts.className}, ` +
                        `maybe the gas is too low.`);
      }
      txHash = _txHash;
    });
    deasync.loopWhile(function () { return typeof receipt !== 'object'; });
    return receipt;
  }

  // Calls a function
  // opts.constant: if a function is to be called constant
  // opts.fName: function Name
  // opts.args: arguments to giv during the call
  // opts.abi
  // opts.address
  call (opts) {
    var Class = this._web3.eth.contract(opts.abi);
    var object = Class.at(opts.address);
    var txHash;
    var result;
    var self = this;
    if (!opts.constant) {
      var _filter = this._web3.eth.filter('latest', function (err, res) {
        if (err) throw err;
        if (!txHash) return null;
        self._web3.eth.getTransactionReceipt(txHash, function (err, _receipt) {
          if (err) throw err;
          if (!_receipt) return null;
          result = _receipt;
        });
      });
    }
    opts.txOptions.from = this._web3.eth.coinbase;
    object[opts.fName]
    .apply(this,
           opts.args.concat([
             opts.txOptions || {},
             function (err, res) {
               if (err) throw err;
               if (opts.constant) {
                 result = res;
               } else {
                 txHash = res;
               }
             }]));
    deasync.loopWhile(function () { return typeof result === 'undefined'; });
    if (typeof _filter === 'object') _filter.stopWatching();
    return result;
  }

  runFilter () {
    this._filter = this._web3.eth.filter('latest', (err, res) => {
      if (err) throw err;
      this.filterCallbacks.forEach(f => f());
    });
  }

  stopFilter () {
    this._filter.stopWatching();
  }

  onBlock (f) {
    if(this.filterCallbacks.indexOf(f) === -1) {
      this.filterCallbacks.push(f);
    }
  }

  removeOnBlock(f) {
    let num = this.filterCallbacks.indexOf(f);
    if(num > -1) this.filterCallbacks.splice(num, 1);
  }

  // @param opts
  //    co - transaction object
  // TODO - refactor without semaphore with purely recursion
  // onBlock can be refactored to destroy it self after each block call
  // and getTxReceipt to register it again if no receipt is found
  tx (co, callback) {
    var semaphore = false;
    var txHash = null;
    var self = this;

    function handleFirstTxReceipt(receipt, cb) {
      if(!receipt) {
        self.onBlock(watch);
      } else {
        return callback(null, receipt);
      }
    }

    var sendTx = this._web3.eth.sendTransaction.bind(this._web3.eth, co);
    var handleTx = (hash, cb) => {
      this.setStatus(`waiting for transaction ${hash} to get included`);
      txHash = hash;
      cb(null, hash);
    }
    var getTxReceipt = this._web3.eth.getTransactionReceipt.bind(this._web3.eth);

    function watch() {
      if(semaphore) return null;
      semaphore = true;
      getTxReceipt(txHash, (err, receipt) => {
        if(!receipt) {
          semaphore = false;
        } else {
          self.removeOnBlock(watch);
          callback(null, receipt);
        }
      });
    };

    this.setStatus('sending transaction');
    async.waterfall([
      sendTx,
      handleTx,
      getTxReceipt,
      handleFirstTxReceipt
    ], (err, res) => {
      if(err) callback(err);
    });
  }

  confirmTx(receipt, callback) {
    var waitForBlock = this.waitForBlock.bind(this, receipt.blockNumber + this.chainenv.confirmationBlocks);
    var getReceipt = this._web3.eth.getTransactionReceipt.bind(this._web3.eth, receipt.transactionHash);
    var compareReceipts = (r2, cb) => {
      if( r2.blockHash === receipt.blockHash ) {
        cb(null, receipt);
      } else {
        this.confirmTx(r2, cb);
      }
    }
    async.waterfall([
      waitForBlock,
      getReceipt,
      compareReceipts
    ], callback);
  }

  setStatus (status) {
    if(this.supervisor) {
      this.supervisor.setStatus(status);
      // throw new Error('supervisor should be here');
    }
  }

  ensureType (type, cb) {
    chain_expert.analyze(this._web3, (err, _type) => {
      if(type === _type) return cb();
      return cb(new Error(`Chain Type don't match: expected ${type} but got ${_type}`));
    });
  }

}

module.exports = Web3Interface;

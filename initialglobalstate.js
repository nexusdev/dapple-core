module.exports = {
  networks: {},
  state: {
    solc_path: "solc" // assume this is known
  },
  chaintypes: {
    ETH: {
      genesis: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
      block2m: "0xc0f4906fea23cf6f3cce98cb44e8e1449e455b28d684dfa9ff65426495584de6"
    },
    ETC: {
      genesis: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
      block2m: "0x3b56d9e73aa7cac630eb718c24923757a7d08b2b1a52d62676a1749e1f345be3"
    },
    MORDEN: {
      genesis: "0x0cd786a2425d16f152c658316c423e6ce1181e15c3295826d7c9904cba9ce303"
    },
    ROPSTEN: {
      genesis: "0x41941023680923e0fe4d74a34bdac8141f2540e3ae90623718e47d66d1ca4a2d"
    }
  }
}

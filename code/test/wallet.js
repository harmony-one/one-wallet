const TestUtil = require('./util')
const unit = require('ethjs-unit')
const ONEUtil = require('../lib/util')
const ONEDebugger = require('../lib/debug')
const ONE = require('../lib/onewallet')

const INTERVAL = 30000
const DURATION = INTERVAL * 8
const SLOT_SIZE = 1

const Logger = TestUtil.Logger
const Debugger = ONEDebugger(Logger)

contract('ONEWallet', (accounts) => {
  const EFFECTIVE_TIME = Math.floor(Date.now() / INTERVAL) * INTERVAL - DURATION / 2
  const ONE_CENT = unit.toWei('0.01', 'ether')
  // eslint-disable-next-line no-unused-vars
  const HALF_DIME = unit.toWei('0.05', 'ether')
  // eslint-disable-next-line no-unused-vars
  const ONE_DIME = unit.toWei('0.1', 'ether')
  const ONE_ETH = unit.toWei('1', 'ether')
  // eslint-disable-next-line no-unused-vars
  const TWO_ETH = unit.toWei('2', 'ether')
  it('must create wallet with expected parameters', async () => {
    const purse = web3.eth.accounts.create()
    const {
      seed,
      hseed,
      wallet,
      root,
      client: {
        leaves,
        layers,
      },
      contract: {
        slotSize,
        t0,
        lifespan,
        interval
      } } = await TestUtil.createWallet({
      effectiveTime: EFFECTIVE_TIME,
      duration: DURATION,
      maxOperationsPerInterval: SLOT_SIZE,
      lastResortAddress: purse.address,
      dailyLimit: ONE_ETH
    })
    console.log({
      seed,
      hseed,
      wallet: wallet.toString(),
      root,
      client: {
        leaves,
        layers,
      },
      contract: {
        slotSize,
        t0,
        lifespan,
        interval
      } })
    Logger.debug(`Sending ${ONE_CENT} from ${accounts[0]} to ${wallet.address}`)
    await web3.eth.sendTransaction({
      from: accounts[0],
      to: wallet.address,
      value: ONE_CENT
    })
    Logger.debug(`Sent ${ONE_CENT} to ${wallet.address}`)
    const balance = await web3.eth.getBalance(wallet.address)
    assert.equal(ONE_CENT, balance, 'Wallet has correct balance')
  })

  it('must commit and reveal a transfer successfully', async () => {
    const purse = web3.eth.accounts.create()
    const { seed, hseed, wallet, root, client: { layers } } = await TestUtil.createWallet({
      effectiveTime: EFFECTIVE_TIME,
      duration: DURATION,
      maxOperationsPerInterval: SLOT_SIZE,
      lastResortAddress: purse.address,
      dailyLimit: ONE_ETH
    })

    await web3.eth.sendTransaction({
      from: accounts[0],
      to: wallet.address,
      value: ONE_CENT
    })

    // can be used with web3's WebsocketProvider, but not PrivateKeyProvider
    // wallet.CheckingCommit({}, (error, result) => {
    //   if (error) {
    //     return console.error(error)
    //   }
    //   console.log(result)
    // })

    Debugger.printLayers({ layers })

    const otp = ONEUtil.genOTP({ seed })
    const index = ONEUtil.timeToIndex({ effectiveTime: EFFECTIVE_TIME })
    const eotp = ONE.computeEOTP({ otp, hseed })
    Logger.debug(`To compute neighbors`, {
      otp: new DataView(otp.buffer).getUint32(0, false),
      eotp: ONEUtil.hexString(eotp),
      index
    })
    const neighbors = ONE.selectMerkleNeighbors({ layers, index })
    const neighbor = neighbors[0]
    const { hash: transferHash, bytes: transferHashInputBytes } = ONE.computeTransferHash({
      neighbor,
      index,
      eotp,
      dest: purse.address,
      amount: ONE_CENT / 2
    })
    Logger.debug(`Committing transfer hash`, { hash: ONEUtil.hexString(transferHash), bytes: ONEUtil.hexString(transferHashInputBytes) })
    await wallet.commit(ONEUtil.hexString(transferHash))
    Logger.debug(`Committed`)
    const neighborsEncoded = neighbors.map(n => ONEUtil.hexString(n))
    Debugger.debugProof({ neighbors, height: layers.length, index, eotp, root })
    const commit = await wallet.commits.call(0)
    Logger.debug({ commit: { hash: commit.hash, timestamp: commit.timestamp.toString() }, currentTimeInSeconds: Math.floor(Date.now() / 1000) })
    Logger.debug(`Revealing transfer with`, {
      neighbors: neighborsEncoded,
      indexWithNonce: index,
      eotp: ONEUtil.hexString(eotp),
      dest: purse.address,
      amount: ONE_CENT / 2
    })
    const wouldSucceed = await wallet.revealTransfer.call(
      neighborsEncoded, index, ONEUtil.hexString(eotp), purse.address, ONE_CENT / 2
    )
    Logger.debug(`Reveal would succeed=${wouldSucceed}`)
    await wallet.revealTransfer(
      neighborsEncoded, index, ONEUtil.hexString(eotp), purse.address, ONE_CENT / 2
    )
    Logger.debug(`Revealed`)
    const walletBalance = await web3.eth.getBalance(wallet.address)
    const purseBalance = await web3.eth.getBalance(purse.address)
    assert.equal(ONE_CENT / 2, walletBalance, 'Wallet has correct balance')
    assert.equal(ONE_CENT / 2, purseBalance, 'Purse has correct balance')
  })

  it('must respect daily limit', async () => {
    const purse = web3.eth.accounts.create()
    const { seed, hseed, wallet, client: { layers } } = await TestUtil.createWallet({
      effectiveTime: EFFECTIVE_TIME,
      duration: DURATION,
      maxOperationsPerInterval: SLOT_SIZE,
      lastResortAddress: purse.address,
      dailyLimit: ONE_CENT
    })
    await web3.eth.sendTransaction({
      from: accounts[0],
      to: wallet.address,
      value: ONE_DIME
    })
    const otp = ONEUtil.genOTP({ seed })
    const index = ONEUtil.timeToIndex({ effectiveTime: EFFECTIVE_TIME })
    const eotp = ONE.computeEOTP({ otp, hseed })
    const neighbors = ONE.selectMerkleNeighbors({ layers, index })
    const neighbor = neighbors[0]
    const { hash: transferHash } = ONE.computeTransferHash({
      neighbor,
      index,
      eotp,
      dest: purse.address,
      amount: HALF_DIME
    })
    const neighborsEncoded = neighbors.map(n => ONEUtil.hexString(n))
    await wallet.commit(ONEUtil.hexString(transferHash))
    await wallet.revealTransfer(
      neighborsEncoded, index, ONEUtil.hexString(eotp), purse.address, HALF_DIME
    )
    const walletBalance = await web3.eth.getBalance(wallet.address)
    const purseBalance = await web3.eth.getBalance(purse.address)
    assert.equal(ONE_DIME, walletBalance, 'Wallet has original balance')
    assert.equal(0, purseBalance, 'Purse has 0 balance')
  })

  it('must recover funds to last resort address', async () => {
    const purse = web3.eth.accounts.create()
    const { seed, hseed, wallet, client: { layers } } = await TestUtil.createWallet({
      effectiveTime: EFFECTIVE_TIME,
      duration: DURATION,
      maxOperationsPerInterval: SLOT_SIZE,
      lastResortAddress: purse.address,
      dailyLimit: ONE_CENT
    })
    await web3.eth.sendTransaction({
      from: accounts[0],
      to: wallet.address,
      value: ONE_DIME
    })
    const otp = ONEUtil.genOTP({ seed })
    const index = ONEUtil.timeToIndex({ effectiveTime: EFFECTIVE_TIME })
    const eotp = ONE.computeEOTP({ otp, hseed })
    const neighbors = ONE.selectMerkleNeighbors({ layers, index })
    const neighbor = neighbors[0]
    const { hash: recoveryHash } = ONE.computeRecoveryHash({ neighbor, index, eotp })
    const neighborsEncoded = neighbors.map(n => ONEUtil.hexString(n))
    await wallet.commit(ONEUtil.hexString(recoveryHash))
    await wallet.revealRecovery(neighborsEncoded, index, ONEUtil.hexString(eotp))
    const walletBalance = await web3.eth.getBalance(wallet.address)
    const purseBalance = await web3.eth.getBalance(purse.address)
    assert.equal(0, walletBalance, 'Wallet has 0 balance')
    assert.equal(ONE_DIME, purseBalance, 'Purse has entire balance')
  })
})

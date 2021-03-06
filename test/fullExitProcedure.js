const util = require("util");
const ethUtil = require('ethereumjs-util')
const BN = ethUtil.BN;
const t = require('truffle-test-utils')
t.init()
const expectThrow = require("../helpers/expectThrow");
const {addresses, keys} = require("./keys");
const {createTransaction, parseTransactionIndex} = require("./createTransaction");
const {createBlock, createMerkleTree} = require("./createBlock");
const testUtils = require('./utils');
const deploy = require("./deploy");

const increaseTime = async function(addSeconds) {
    await web3.currentProvider.send({jsonrpc: "2.0", method: "evm_increaseTime", params: [addSeconds], id: 0})
    await web3.currentProvider.send({jsonrpc: "2.0", method: "evm_mine", params: [], id: 1})
}

const {
    TxTypeFund, 
    TxTypeMerge, 
    TxTypeSplit} = require("../lib/Tx/RLPtx");

contract('PlasmaParent exit procedure', async (accounts) => {
    const operatorAddress = accounts[0];
    const operatorKey = keys[0];

    let queue;
    let plasma;
    let storage;
    let firstHash;

    const operator = accounts[0];

    const alice    = addresses[2];
    const aliceKey = keys[2];
    const bob      = addresses[3];
    const bobKey = keys[3];
    
    beforeEach(async () => {
        const result = await deploy(operator, operatorAddress);
        ({plasma, firstHash, queue, storage} = result);
    })

    it('Simulate exit procedure', async () => {
        const withdrawCollateral = await plasma.WithdrawCollateral();
        await plasma.deposit({from: alice, value: "100"});

        const allTXes = [];
        const fundTX = createTransaction(TxTypeFund, 0, 
            [{
                blockNumber: 0,
                txNumberInBlock: 0,
                outputNumberInTransaction: 0,
                amount: 0
            }],
            [{
                amount: 100,
                to: alice
            }],
                operatorKey
        )
        allTXes.push(fundTX)
        const block = createBlock(1, allTXes.length, firstHash, allTXes,  operatorKey)
        await testUtils.submitBlock(plasma, block);

        const proofObject = block.getProofForTransactionByNumber(0);
        const {proof, tx} = proofObject;
        let submissionReceipt = await plasma.startExit(
            1, 0, ethUtil.bufferToHex(tx.serialize()), ethUtil.bufferToHex(proof),
            {from: alice, value: withdrawCollateral}
        )
        console.log("Single exit gas price for exiting a deposit transaction is " + submissionReceipt.receipt.gasUsed)
                // struct ExitRecord {
                //     bytes32 transactionRef;
                //     //32 bytes
                //     uint256 amount;
                //     // 64 bytes
                //     address owner;
                //     uint64 timePublished;
                //     uint32 blockNumber;
                //     // 96 bytes
                //     uint32 transactionNumber;
                //     uint8 outputNumber;
                //     bool isValid;
                //     bool isLimbo;
                //     // 96 + 7 bytes
                // }
        const transactionPublishedEvent = submissionReceipt.logs[0]
        const txHashFromEvent = transactionPublishedEvent.args._hash;
        const txDataFromEvent = transactionPublishedEvent.args._data;
        const exitRecordHash = submissionReceipt.logs[2].args._partialHash;
        const exitRecord = await plasma.exitRecords(exitRecordHash);
        const txData = ethUtil.bufferToHex(tx.serialize())
        const txHash = ethUtil.bufferToHex(ethUtil.sha3(proofObject.tx.serialize()))

        assert(exitRecord[0] === txHash);
        assert(exitRecord[1].toNumber() === 100)
        assert(exitRecord[2] === alice);
        assert(exitRecord[4].toString(10) === "1")
        assert(exitRecord[5].toNumber() === 0)
        assert(exitRecord[6].toNumber() === 0)
        assert(exitRecord[7] === true)
        assert(exitRecord[8] === false)

        assert(txHash === txHashFromEvent);
        assert(txData === txDataFromEvent); 
        
        let oldBalance = await web3.eth.getBalance(alice);

        size = await queue.currentSize();
        assert(size.toString(10) === "1");

        minimalItem = await queue.getMin();
        assert(minimalItem === exitRecordHash);

        let exitDelay = await plasma.ExitDelay()
        await increaseTime(exitDelay.toNumber() + 1)

        submissionReceipt = await plasma.finalizeExits(1);
        console.log("One item in the queue finalization gas = " + submissionReceipt.receipt.gasUsed)
        let newBalance = await web3.eth.getBalance(alice);
        assert(newBalance.gt(oldBalance));
        let succesfulExit = await plasma.succesfulExits(exitRecordHash);
        assert(succesfulExit);
        size = await queue.currentSize();
        assert(size.toString(10) === "0");

    })

    it('Simulate exit procedure with invalid (spent) transaction in queue before valid', async () => {
        const withdrawCollateral = await plasma.WithdrawCollateral();
        await plasma.deposit({from: alice, value: "100"});

        const allTXes = [];
        const fundTX = createTransaction(TxTypeFund, 0, 
            [{
                blockNumber: 0,
                txNumberInBlock: 0,
                outputNumberInTransaction: 0,
                amount: 0
            }],
            [{
                amount: 100,
                to: alice
            }],
                operatorKey
        )
        allTXes.push(fundTX)
        const block = createBlock(1, allTXes.length, firstHash, allTXes,  operatorKey)
        await testUtils.submitBlock(plasma, block);
        let proofObject = block.getProofForTransactionByNumber(0);
        let {proof, tx} = proofObject;
        let submissionReceipt = await plasma.startExit(
            1, 0, ethUtil.bufferToHex(tx.serialize()), ethUtil.bufferToHex(proof),
            {from: alice, value: withdrawCollateral}
        )
        const transactionPublishedEvent = submissionReceipt.logs[0]
        const txHashFromEvent = transactionPublishedEvent.args._hash;
        const txDataFromEvent = transactionPublishedEvent.args._data;
        const alicePriority = submissionReceipt.logs[1].args._priority;

        let exitRecordHash = submissionReceipt.logs[2].args._partialHash;
        let exitRecord = await plasma.exitRecords(exitRecordHash);
        let txData = ethUtil.bufferToHex(tx.serialize())
        let txHash = ethUtil.bufferToHex(ethUtil.sha3(proofObject.tx.serialize()))

        assert(exitRecord[0] === txHash);
        assert(exitRecord[1].toNumber() === 100)
        assert(exitRecord[2] === alice);
        assert(exitRecord[4].toString(10) === "1")
        assert(exitRecord[5].toNumber() === 0)
        assert(exitRecord[6].toNumber() === 0)
        assert(exitRecord[7] === true)
        assert(exitRecord[8] === false)

        assert(txHash === txHashFromEvent);
        assert(txData === txDataFromEvent); 

        let nextHash = await plasma.hashOfLastSubmittedBlock();
        const spendingTX = createTransaction(TxTypeSplit, 0, 
            [{
                blockNumber: 1,
                txNumberInBlock: 0,
                outputNumberInTransaction: 0,
                amount: 100
            }],
            [{
                amount: 100,
                to: bob
            }],
                aliceKey
        )
        const block2 = createBlock(2, 1, nextHash, [spendingTX],  operatorKey)
        await testUtils.submitBlock(plasma, block2);

        proofObject = block2.getProofForTransactionByNumber(0);
        ({proof, tx} = proofObject);

        submissionReceipt = await plasma.challengeNormalExitByShowingExitBeingSpent(
            exitRecordHash, 2, ethUtil.bufferToHex(tx.serialize()), ethUtil.bufferToHex(proof), 0
        )

        exitRecordHash = submissionReceipt.logs[0].args._partialHash;
        exitRecord = await plasma.exitRecords(exitRecordHash);
        const aliceHash = exitRecordHash;
        assert(exitRecord[0] === txHash);
        assert(exitRecord[1].toNumber() === 100)
        assert(exitRecord[2] === alice);
        assert(exitRecord[4].toString(10) === "1")
        assert(exitRecord[5].toNumber() === 0)
        assert(exitRecord[6].toNumber() === 0)
        assert(exitRecord[7] === false)
        assert(exitRecord[8] === false)

        assert(txHash === txHashFromEvent);
        assert(txData === txDataFromEvent);

        submissionReceipt = await plasma.startExit( 2, 0, ethUtil.bufferToHex(tx.serialize()), ethUtil.bufferToHex(proof),
            {from: bob, value: withdrawCollateral});

        exitRecordHash = submissionReceipt.logs[2].args._partialHash;
        exitRecord = await plasma.exitRecords(exitRecordHash);
        const bobPriority = submissionReceipt.logs[1].args._priority;

        assert(bobPriority.gt(alicePriority));
        txData = ethUtil.bufferToHex(tx.serialize())
        txHash = ethUtil.bufferToHex(ethUtil.sha3(proofObject.tx.serialize()))

        const bobHash = exitRecordHash;
        assert(exitRecord[0] === txHash);
        assert(exitRecord[1].toNumber() === 100)
        assert(exitRecord[2] === bob);
        assert(exitRecord[4].toString(10) === "2")
        assert(exitRecord[5].toNumber() === 0)
        assert(exitRecord[6].toNumber() === 0)
        assert(exitRecord[7] === true)
        assert(exitRecord[8] === false)
        
        let oldBalanceAlice = await web3.eth.getBalance(alice);
        let oldBalanceBob = await web3.eth.getBalance(bob);

        size = await queue.currentSize();
        assert(size.toString(10) === "2");

        minimalItem = await queue.getMin();
        assert(minimalItem === aliceHash);

        let exitDelay = await plasma.ExitDelay()
        await increaseTime(exitDelay.toNumber() + 1)

        submissionReceipt = await plasma.finalizeExits(2);
        console.log("Two items in the queue finalization gas = " + submissionReceipt.receipt.gasUsed)
        let newBalanceAlice = await web3.eth.getBalance(alice);
        let newBalanceBob = await web3.eth.getBalance(bob);
        assert(newBalanceAlice.eq(oldBalanceAlice));
        assert(newBalanceBob.gt(oldBalanceBob));
        let succesfulExit = await plasma.succesfulExits(bobHash);
        assert(succesfulExit);
        succesfulExit = await plasma.succesfulExits(aliceHash);
        assert(!succesfulExit);
        size = await queue.currentSize();
        assert(size.toString(10) === "0");

    })

    it('Should pop only matured items from the exit queue', async () => {
        const withdrawCollateral = await plasma.WithdrawCollateral();
        await plasma.deposit({from: alice, value: "100"});

        const allTXes = [];
        const fundTX = createTransaction(TxTypeFund, 0, 
            [{
                blockNumber: 0,
                txNumberInBlock: 0,
                outputNumberInTransaction: 0,
                amount: 0
            }],
            [{
                amount: 100,
                to: alice
            }],
                operatorKey
        )
        allTXes.push(fundTX)
        const block = createBlock(1, allTXes.length, firstHash, allTXes,  operatorKey)
        await testUtils.submitBlock(plasma, block);
        let proofObject = block.getProofForTransactionByNumber(0);
        let {proof, tx} = proofObject;
        let submissionReceipt = await plasma.startExit(
            1, 0, ethUtil.bufferToHex(tx.serialize()), ethUtil.bufferToHex(proof),
            {from: alice, value: withdrawCollateral}
        )
        const transactionPublishedEvent = submissionReceipt.logs[0]
        const txHashFromEvent = transactionPublishedEvent.args._hash;
        const txDataFromEvent = transactionPublishedEvent.args._data;
        const alicePriority = submissionReceipt.logs[1].args._priority;

        let exitRecordHash = submissionReceipt.logs[2].args._partialHash;
        const aliceHash = exitRecordHash;
        let exitRecord = await plasma.exitRecords(exitRecordHash);
        let txData = ethUtil.bufferToHex(tx.serialize())
        let txHash = ethUtil.bufferToHex(ethUtil.sha3(proofObject.tx.serialize()))

        assert(exitRecord[0] === txHash);
        assert(exitRecord[1].toNumber() === 100)
        assert(exitRecord[2] === alice);
        assert(exitRecord[4].toString(10) === "1")
        assert(exitRecord[5].toNumber() === 0)
        assert(exitRecord[6].toNumber() === 0)
        assert(exitRecord[7] === true)
        assert(exitRecord[8] === false)

        assert(txHash === txHashFromEvent);
        assert(txData === txDataFromEvent); 

        let nextHash = await plasma.hashOfLastSubmittedBlock();
        const spendingTX = createTransaction(TxTypeSplit, 0, 
            [{
                blockNumber: 1,
                txNumberInBlock: 0,
                outputNumberInTransaction: 0,
                amount: 100
            }],
            [{
                amount: 100,
                to: bob
            }],
                aliceKey
        )
        const block2 = createBlock(2, 1, nextHash, [spendingTX],  operatorKey)
        await testUtils.submitBlock(plasma, block2);

        proofObject = block2.getProofForTransactionByNumber(0);
        ({proof, tx} = proofObject);

        let exitDelay = await plasma.ExitDelay()
        await increaseTime(Math.floor(exitDelay.toNumber()/2))

        submissionReceipt = await plasma.startExit( 2, 0, ethUtil.bufferToHex(tx.serialize()), ethUtil.bufferToHex(proof),
            {from: bob, value: withdrawCollateral});

        exitRecordHash = submissionReceipt.logs[2].args._partialHash;
        exitRecord = await plasma.exitRecords(exitRecordHash);
        const bobPriority = submissionReceipt.logs[1].args._priority;

        assert(bobPriority.gt(alicePriority));
        txData = ethUtil.bufferToHex(tx.serialize())
        txHash = ethUtil.bufferToHex(ethUtil.sha3(proofObject.tx.serialize()))

        const bobHash = exitRecordHash;
        assert(exitRecord[0] === txHash);
        assert(exitRecord[1].toNumber() === 100)
        assert(exitRecord[2] === bob);
        assert(exitRecord[4].toString(10) === "2")
        assert(exitRecord[5].toNumber() === 0)
        assert(exitRecord[6].toNumber() === 0)
        assert(exitRecord[7] === true)
        assert(exitRecord[8] === false)
        
        await expectThrow(plasma.finalizeExits(100));

        await increaseTime(Math.floor(exitDelay.toNumber()/2) + 100)

        let oldBalanceAlice = await web3.eth.getBalance(alice);
        let oldBalanceBob = await web3.eth.getBalance(bob);

        size = await queue.currentSize();
        assert(size.toString(10) === "2");

        minimalItem = await queue.getMin();
        assert(minimalItem === aliceHash);

        submissionReceipt = await plasma.finalizeExits(100);
        await expectThrow(plasma.finalizeExits(100));
        let newBalanceAlice = await web3.eth.getBalance(alice);
        let newBalanceBob = await web3.eth.getBalance(bob);
        assert(newBalanceAlice.gt(oldBalanceAlice));
        assert(newBalanceBob.eq(oldBalanceBob));
        let succesfulExit = await plasma.succesfulExits(bobHash);
        assert(!succesfulExit);
        succesfulExit = await plasma.succesfulExits(aliceHash);
        assert(succesfulExit);
        size = await queue.currentSize();
        assert(size.toString(10) === "1");
        minimalItem = await queue.getMin();
        assert(minimalItem === bobHash);

        await increaseTime(exitDelay.toNumber())
        submissionReceipt = await plasma.finalizeExits(100);
        newBalanceBob = await web3.eth.getBalance(bob);
        assert(newBalanceBob.gt(oldBalanceBob));
        succesfulExit = await plasma.succesfulExits(bobHash);
        assert(succesfulExit);
    })
})

function prettyPrint(res) {
    for (let field of res) {
        console.log(field.toString(10));
    }
}


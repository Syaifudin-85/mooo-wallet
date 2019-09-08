import { WalletGenerationService } from './wallet-generation.service';
import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpErrorResponse } from '@angular/common/http';
import * as bitcoinjs from 'bitcoinjs-lib';
import { Big } from 'big.js';
import { Transaction } from './core/transaction';
import { Call } from './core/electrum/call';
import { Procedure } from './core/electrum/procedure';
import { Output } from './core/output';
import { Fee } from './core/bitcoinfees/fee';
import { ConversionService } from './conversion.service';
import { map } from 'rxjs/operators';
import { JsonRpcResponse } from './core/electrum/json-rpc-response';
import { throwError } from 'rxjs';
import { Derived } from './core/derived';

@Injectable({
    providedIn: 'root'
})
export class SendService {

    constructor(private httpClient: HttpClient, private walletGenerationService: WalletGenerationService,
        private conversionService: ConversionService) { }

    calculateBalance(utxoArray: Transaction[]) {
        let balance = new Big(0)
        for (let utxo of utxoArray) {
            balance = balance.plus(this.conversionService.satoshiToBitcoin(utxo.satoshis))
            balance.plus(new Big(0))
        }
        return balance
    }

    feeForEstimatedConfirmationTime(minutes: number, feeArray: Fee[]) {
        for (let fee of feeArray) {
            if (fee.maxMinutes < 60) {
                return fee
            }
        }
    }

    removeTailingZeros(text: string) {
        while (text[text.length - 1] === "0") {
            text = text.substring(0, text.length - 1)
        }
        if (text[text.length - 1] === ".") {
            text = text.substring(0, text.length - 1)
        }
        return text
    }

    isValidAddress(addressString: string, network: bitcoinjs.Network) {
        try {
            bitcoinjs.address.toOutputScript(addressString, network)
            return true
        } catch (e) {
            return false
        }
    }

    createMnemonicTransaction(mnemonic: string, passphrase: string, xpub: string, outputArray: Output[], changeOutput: Output, utxoArray: Transaction[], network: bitcoinjs.Network) {
        utxoArray.forEach(transaction => {
            let wif = this.walletGenerationService.indexNodeFromMnemonic(mnemonic, passphrase, xpub, transaction.derived, network).toWIF()
            let ecPair = bitcoinjs.ECPair.fromWIF(wif, network)
            transaction.ecPair = ecPair
        })
        return this.createTransaction(outputArray, changeOutput, utxoArray, network)
    }

    createWifTransaction(outputArray: Output[], changeOutput: Output, utxoArray: Transaction[], from: string, wif: string, passphrase: string, network: bitcoinjs.Network) {
        let ecPair = this.walletGenerationService.ecPairFromWif(wif, passphrase, network)
        utxoArray.forEach(transaction => {
            transaction.ecPair = ecPair
        })
        return this.createTransaction(outputArray, changeOutput, utxoArray, network)
    }

    createTransaction(outputArray: Output[], changeOutput: Output, utxoArray: Transaction[], network: bitcoinjs.Network) {
        let psbt = new bitcoinjs.Psbt({ network: network })
        for (let i = 0; i < utxoArray.length; i++) {
            let utxo = utxoArray[i]
            if (utxo.derived.purpose === 84) {
                let transaction = bitcoinjs.Transaction.fromHex(utxo.transactionHex)
                psbt.addInput({
                    hash: utxo.id,
                    index: utxo.vout,
                    witnessUtxo: {
                        script: transaction.outs[utxo.vout].script,
                        value: utxo.satoshis
                    }
                })
            } else if (utxo.derived.purpose === 49) {
                const p2wpkh = bitcoinjs.payments.p2wpkh({ pubkey: utxo.ecPair.publicKey, network: network })
                const p2sh = bitcoinjs.payments.p2sh({ redeem: p2wpkh, network: network })
                let transaction = bitcoinjs.Transaction.fromHex(utxo.transactionHex)
                psbt.addInput({
                    hash: utxo.id,
                    index: utxo.vout,
                    witnessUtxo: {
                        script: transaction.outs[utxo.vout].script,
                        value: utxo.satoshis
                    },
                    redeemScript: p2sh.redeem.output
                })
            } else if (utxo.derived.purpose === 44) {
                psbt.addInput({ hash: utxo.id, index: utxo.vout, nonWitnessUtxo: Buffer.from(utxo.transactionHex, 'hex') })
            } else {
                throw new Error("Incompatible purpose " + utxo.derived.purpose)
            }
        }
        for (let i = 0; i < outputArray.length; i++) {
            let output = outputArray[i]
            psbt.addOutput({ address: output.destination, value: output.amountInSatochi() })
        }
        if (changeOutput !== null && !changeOutput.amount.eq(0)) {
            psbt.addOutput({ address: changeOutput.destination, value: changeOutput.amountInSatochi() })
        }
        for (let i = 0; i < utxoArray.length; i++) {
            let utxo = utxoArray[i]
            psbt.signInput(i, utxo.ecPair)
            psbt.validateSignaturesOfInput(i)
        }
        psbt.finalizeAllInputs()
        let transaction = psbt.extractTransaction()
        return transaction
    }

    loadUTXO(derivedList: Array<Derived>, environment) {
        let call = new Call(environment.electrumServer, environment.electrumPort)
        let procedure = new Procedure(1, "server.version")
        procedure.params.push(environment.electrumProtocol)
        procedure.params.push(environment.electrumProtocol)
        call.procedureList.push(procedure.toString())
        procedure = new Procedure(2, "blockchain.headers.subscribe")
        call.procedureList.push(procedure.toString())
        procedure = new Procedure(3, "blockchain.relayfee")
        call.procedureList.push(procedure.toString())
        let i = 4
        derivedList.forEach(derived => {
            procedure = new Procedure(i, "blockchain.scripthash.listunspent")
            procedure.params.push(this.scriptHashFrom(derived.address, environment))
            call.procedureList.push(procedure.toString())
            i++
        })
        return this.httpClient.post<any[]>(environment.proxyAddress + '/api/proxy', call).pipe(map((data => {
            let responseList = new Array<JsonRpcResponse>()
            for (let responseString of data) {
                let response = JsonRpcResponse.from(responseString)
                if (response.error) {
                    throwError(response.error)
                }
                responseList.push(response)
            }
            responseList = responseList.sort((a, b) => a.id > b.id ? 1 : -1)
            let lastBlockHeight: number = responseList[1].result.height
            let minimumRelayFeeInBtc = responseList[2].result
            let utxoArray = new Array<Transaction>()
            for (let index = 3; index < responseList.length; index++) {
                const utxoList = responseList[index].result
                for (let item of utxoList) {
                    let utxo = new Transaction()
                    utxo.id = item.tx_hash
                    utxo.vout = item.tx_pos
                    utxo.satoshis = item.value
                    utxo.height = item.height
                    //TODO use big
                    utxo.amount = parseFloat(this.conversionService.satoshiToBitcoin(utxo.satoshis).toFixed(8))
                    utxo.derived = derivedList[index - 3]
                    if (utxo.height > 0)
                        utxo.confirmations = lastBlockHeight - utxo.height + 1
                    else
                        utxo.confirmations = 0
                    utxoArray.push(utxo)
                }
                utxoArray = utxoArray.filter((utxo: Transaction) => utxo.confirmations > 0)
            }
            return { 'minimumRelayFeeInBtc': minimumRelayFeeInBtc, 'utxoArray': utxoArray }
        })))
    }

    rawTransactionListFrom(utxoArray: Array<Transaction>, environment) {
        let call = new Call(environment.electrumServer, environment.electrumPort)
        let procedure = new Procedure(1, "server.version")
        procedure.params.push(environment.electrumProtocol)
        procedure.params.push(environment.electrumProtocol)
        call.procedureList.push(procedure.toString())
        let i = 1
        utxoArray.forEach(transaction => {
            procedure = new Procedure(++i, "blockchain.transaction.get")
            procedure.params.push(transaction.id)
            call.procedureList.push(procedure.toString())
        })
        return this.httpClient.post<string[]>(environment.proxyAddress + '/api/proxy', call).pipe(map(data => {
            data = data.map(d => JSON.parse(d))
                .sort((a, b) => a.id > b.id ? 1 : -1)
                .slice(1)
                .map(d => d.result)
            return data
        }))
    }

    scriptHashFrom(addressString: string, environment) {
        let outputScript = bitcoinjs.address.toOutputScript(addressString, environment.network)
        let reversedScriptHash = new Buffer(bitcoinjs.crypto.sha256(outputScript).reverse())
        return reversedScriptHash.toString("hex")
    }

    broadcast(transaction: string, environment) {
        let call = new Call(environment.electrumServer, environment.electrumPort)
        let procedure = new Procedure(1, "server.version")
        procedure.params.push(environment.electrumProtocol)
        procedure.params.push(environment.electrumProtocol)
        call.procedureList.push(procedure.toString())
        procedure = new Procedure(2, "blockchain.transaction.broadcast")
        procedure.params.push(transaction)
        call.procedureList.push(procedure.toString())
        return this.httpClient.post<any[]>(environment.proxyAddress + '/api/proxy', call)
    }

}

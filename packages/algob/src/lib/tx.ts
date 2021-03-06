import { encodeNote, mkTransaction } from "@algorand-builder/runtime";
import type { ExecParams, TxParams } from "@algorand-builder/runtime/build/types";
import { SignType } from "@algorand-builder/runtime/build/types";
import algosdk, { Algodv2, SuggestedParams, Transaction } from "algosdk";

import {
  AlgobDeployer,
  ASADef,
  ASADeploymentFlags
} from "../types";
import { ALGORAND_MIN_TX_FEE } from "./algo-operator";
import { loadSignedTxnFromFile } from "./files";

export async function getSuggestedParams (algocl: Algodv2): Promise<SuggestedParams> {
  const params = await algocl.getTransactionParams().do();
  // Private chains may have an issue with firstRound
  if (params.firstRound === 0) {
    throw new Error("Suggested params returned 0 as firstRound. Ensure that your node progresses.");
    // params.firstRound = 1
  }
  return params;
}

/// creates common transaction parameters. If suggested params are not provided, will call
/// Algorand node to get suggested parameters.
export async function mkTxParams (
  algocl: Algodv2, userParams: TxParams, s?: SuggestedParams): Promise<SuggestedParams> {
  if (s === undefined) { s = await getSuggestedParams(algocl); }

  s.flatFee = userParams.totalFee !== undefined;
  s.fee = userParams.totalFee ?? userParams.feePerByte ?? ALGORAND_MIN_TX_FEE;
  if (s.flatFee) s.fee = Math.max(s.fee, ALGORAND_MIN_TX_FEE);

  s.firstRound = userParams.firstValid ?? s.firstRound;
  s.lastRound = userParams.firstValid === undefined || userParams.validRounds === undefined
    ? s.lastRound
    : userParams.firstValid + userParams.validRounds;
  return s;
}

export function makeAssetCreateTxn (
  name: string, asaDef: ASADef, flags: ASADeploymentFlags, txSuggestedParams: SuggestedParams
): Transaction {
  // If TxParams has noteb64 or note , it gets precedence
  let note;
  if (flags.noteb64 ?? flags.note) {
    // TxParams note
    note = encodeNote(flags.note, flags.noteb64);
  } else if (asaDef.noteb64 ?? asaDef.note) {
    // ASA definition note
    note = encodeNote(asaDef.note, asaDef.noteb64);
  }

  // https://github.com/algorand/docs/blob/master/examples/assets/v2/javascript/AssetExample.js#L104
  return algosdk.makeAssetCreateTxnWithSuggestedParams(
    flags.creator.addr,
    note,
    asaDef.total,
    asaDef.decimals,
    asaDef.defaultFrozen,
    asaDef.manager,
    asaDef.reserve,
    asaDef.freeze,
    asaDef.clawback,
    asaDef.unitName,
    name,
    asaDef.url,
    asaDef.metadataHash,
    txSuggestedParams
  );
}

export function makeASAOptInTx (
  addr: string,
  assetID: number,
  params: SuggestedParams
): Transaction {
  const closeRemainderTo = undefined;
  const revocationTarget = undefined;
  const amount = 0;
  const note = undefined;
  return algosdk.makeAssetTransferTxnWithSuggestedParams(
    addr,
    addr,
    closeRemainderTo,
    revocationTarget,
    amount,
    note,
    assetID,
    params);
}

/**
 * Returns signed transaction
 * @param txn unsigned transaction
 * @param execParams transaction execution parametrs
 */
function signTransaction (txn: Transaction, execParams: ExecParams): Uint8Array {
  switch (execParams.sign) {
    case SignType.SecretKey: {
      return txn.signTxn(execParams.fromAccount.sk);
    }
    case SignType.LogicSignature: {
      const logicsig = execParams.lsig;
      if (logicsig === undefined) {
        throw new Error("logic signature for this transaction was not passed or - is not defined");
      }
      return algosdk.signLogicSigTransactionObject(txn, logicsig).blob;
    }
    default: {
      throw new Error("Unknown type of signature");
    }
  }
}

/**
 * Send signed transaction to network and wait for confirmation
 * @param deployer AlgobDeployer
 * @param rawTxns Signed Transaction(s)
 */
async function sendAndWait (
  deployer: AlgobDeployer,
  rawTxns: Uint8Array | Uint8Array[]): Promise<algosdk.ConfirmedTxInfo> {
  const txInfo = await deployer.algodClient.sendRawTransaction(rawTxns).do();
  return await deployer.waitForConfirmation(txInfo.txId);
}

/**
 * Execute single transaction or group of transactions (atomic transaction)
 * @param deployer AlgobDeployer
 * @param execParams transaction parameters or atomic transaction parameters
 */
export async function executeTransaction (
  deployer: AlgobDeployer,
  execParams: ExecParams | ExecParams[]): Promise<algosdk.ConfirmedTxInfo> {
  const suggestedParams = await getSuggestedParams(deployer.algodClient);
  const mkTx = async (p: ExecParams): Promise<Transaction> =>
    mkTransaction(p,
      await mkTxParams(deployer.algodClient, p.payFlags, Object.assign({}, suggestedParams)));

  let signedTxn;
  if (Array.isArray(execParams)) {
    if (execParams.length > 16) { throw new Error("Maximum size of an atomic transfer group is 16"); }

    let txns = [];
    for (const t of execParams) { txns.push(await mkTx(t)); }
    txns = algosdk.assignGroupID(txns);
    signedTxn = txns.map((txn: Transaction, index: number) => {
      const signed = signTransaction(txn, execParams[index]);
      deployer.log(`Signed transaction ${index}`, signed);
      return signed;
    });
  } else {
    const txn = await mkTx(execParams);
    signedTxn = signTransaction(txn, execParams);
    deployer.log(`Signed transaction:`, signedTxn);
  }
  const confirmedTx = await sendAndWait(deployer, signedTxn);
  console.log(confirmedTx);
  return confirmedTx;
}

/**
 * Decode signed txn from file and send to network.
 * probably won't work, because transaction contains fields like
 * firstValid and lastValid which might not be equal to the
 * current network's blockchain block height.
 * @param deployer AlgobDeployer
 * @param fileName raw signed txn .tx file
 */
export async function executeSignedTxnFromFile (
  deployer: AlgobDeployer,
  fileName: string): Promise<algosdk.ConfirmedTxInfo> {
  const signedTxn = loadSignedTxnFromFile(fileName);
  if (signedTxn === undefined) { throw new Error(`File ${fileName} does not exist`); }

  console.debug("Decoded txn from %s: %O", fileName, algosdk.decodeSignedTransaction(signedTxn));
  const confirmedTx = await sendAndWait(deployer, signedTxn);
  console.log(confirmedTx);
  return confirmedTx;
}

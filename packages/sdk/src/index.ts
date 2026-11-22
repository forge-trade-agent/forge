/**
 * @sealdesk/sdk — one import for both sides of a private block trade.
 *
 *   const desk = await Desk.connect({ baseUrl: "https://api.desk.example" }, "https://desk.example");
 *   const block = await desk.postBlock({ side: "buy", token, payToken, amount, replyWindow: "1h" });
 *   const answers = await desk.readAnswers({ rfqId: block.rfq.id, manageToken: block.manageToken, secretKey: block.secretKey });
 *   const deal = await desk.accept({ rfqId: block.rfq.id, manageToken: block.manageToken, answer: answers[0], wallet });
 *   await new EscrowClient(publicClient, desk.cfg.escrow).depositPayment(walletClient, deal.terms);
 */
export { ForgeApi, type NotifyChannel, type SiteCa } from "./api.ts";
export { Desk, randomSalt, signerFromWallet, type DeskConfig, type PostedBlock, type RankedAnswer, type SentAnswer, type TypedSigner } from "./desk.ts";
export { EscrowClient, type OnChainStatus } from "./onchain.ts";
export { checkExposure, viemExposureReader, type ExposureFinding, type ExposureInput, type ExposureLevel, type ExposureReader, type ExposureReport, type TransferLog } from "./exposure.ts";
export { ForgeError, newIdempotencyKey, type HttpOptions } from "./http.ts";
export { subscribe, parseFrame, type StreamEvent, type Subscription } from "./stream.ts";
export type * from "./types.ts";
export {
  buildPrivateLink,
  completeTerms,
  dealIdOf,
  decryptBackup,
  encryptBackup,
  parsePrivateLink,
  POSTER_FIELDS,
  type BackupEntry,
} from "@sealdesk/crypto";

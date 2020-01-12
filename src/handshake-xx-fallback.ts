import { Buffer } from "buffer";

import { XXHandshake } from "./handshake-xx";
import { XX } from "./handshakes/xx";
import { KeyPair, PeerId } from "./@types/libp2p";
import { bytes, bytes32 } from "./@types/basic";
import {
  verifySignedPayload,
} from "./utils";
import { logger } from "./logger";
import { WrappedConnection } from "./noise";
import {decode0, decode1, encode1} from "./encoder";

export class XXFallbackHandshake extends XXHandshake {
  private ephemeralKeys?: KeyPair;
  private initialMsg: bytes;

  constructor(
    isInitiator: boolean,
    payload: bytes,
    prologue: bytes32,
    staticKeypair: KeyPair,
    connection: WrappedConnection,
    remotePeer: PeerId,
    initialMsg: bytes,
    ephemeralKeys?: KeyPair,
    handshake?: XX,
  ) {
    super(isInitiator, payload, prologue, staticKeypair, connection, remotePeer, handshake);
    if (ephemeralKeys) {
      this.ephemeralKeys = ephemeralKeys;
    }
    this.initialMsg = initialMsg;
  }

  // stage 0
  public async propose(): Promise<void> {
    if (this.isInitiator) {
      this.xx.sendMessage(this.session, Buffer.alloc(0), this.ephemeralKeys);
      logger("XX Fallback Stage 0 - Initialized state as the first message was sent by initiator.");
    } else {
      logger("XX Fallback Stage 0 - Responder waiting to receive first message...");
      const receivedMessageBuffer = decode0(this.initialMsg);
      this.xx.recvMessage(this.session, {
        ne: receivedMessageBuffer.ne,
        ns: Buffer.alloc(0),
        ciphertext: Buffer.alloc(0),
      });
      logger("XX Fallback Stage 0 - Responder received first message.");
    }
  }

  // stage 1
  public async exchange(): Promise<void> {
    if (this.isInitiator) {
      logger('XX Fallback Stage 1 - Initiator waiting to receive first message from responder...');
      const receivedMessageBuffer = decode1(this.initialMsg);
      const plaintext = this.xx.recvMessage(this.session, receivedMessageBuffer);
      logger('XX Fallback Stage 1 - Initiator received the message. Got remote\'s static key.');

      logger("Initiator going to check remote's signature...");
      try {
        await verifySignedPayload(receivedMessageBuffer.ns, plaintext, this.remotePeer.id);
      } catch (e) {
        throw new Error(`Error occurred while verifying signed payload: ${e.message}`);
      }
      logger("All good with the signature!");
    } else {
      logger('XX Fallback Stage 1 - Responder sending out first message with signed payload and static key.');
      const messageBuffer = this.xx.sendMessage(this.session, this.payload);
      this.connection.writeLP(encode1(messageBuffer));
      logger('XX Fallback Stage 1 - Responder sent the second handshake message with signed payload.')
    }
  }
}
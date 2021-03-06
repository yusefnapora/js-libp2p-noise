import { Buffer } from 'buffer';
import { BN } from 'bn.js';

import { bytes32, bytes } from '../@types/basic'
import { KeyPair } from '../@types/libp2p'
import {generateKeypair, getHkdf, isValidPublicKey} from '../utils';
import { HandshakeState, MessageBuffer, NoiseSession } from "../@types/handshake";
import {AbstractHandshake} from "./abstract-handshake";


export class XXHandshake extends AbstractHandshake {
  private initializeInitiator(prologue: bytes32, s: KeyPair, rs: bytes32, psk: bytes32): HandshakeState {
    const name = "Noise_XX_25519_ChaChaPoly_SHA256";
    const ss = this.initializeSymmetric(name);
    this.mixHash(ss, prologue);
    const re = Buffer.alloc(32);

    return { ss, s, rs, psk, re };
  }

  private initializeResponder(prologue: bytes32, s: KeyPair, rs: bytes32, psk: bytes32): HandshakeState {
    const name = "Noise_XX_25519_ChaChaPoly_SHA256";
    const ss = this.initializeSymmetric(name);
    this.mixHash(ss, prologue);
    const re = Buffer.alloc(32);

    return { ss, s, rs, psk, re };
  }

  private writeMessageA(hs: HandshakeState, payload: bytes): MessageBuffer {
    const ns = Buffer.alloc(0);
    hs.e = generateKeypair();

    const ne = hs.e.publicKey;

    this.mixHash(hs.ss, ne);
    const ciphertext = this.encryptAndHash(hs.ss, payload);

    return {ne, ns, ciphertext};
  }

  private writeMessageB(hs: HandshakeState, payload: bytes): MessageBuffer {
    hs.e = generateKeypair();
    const ne = hs.e.publicKey;
    this.mixHash(hs.ss, ne);

    this.mixKey(hs.ss, this.dh(hs.e.privateKey, hs.re));
    const spk = Buffer.from(hs.s.publicKey);
    const ns = this.encryptAndHash(hs.ss, spk);

    this.mixKey(hs.ss, this.dh(hs.s.privateKey, hs.re));
    const ciphertext = this.encryptAndHash(hs.ss, payload);

    return { ne, ns, ciphertext };
  }

  private writeMessageC(hs: HandshakeState, payload: bytes) {
    const spk = Buffer.from(hs.s.publicKey);
    const ns = this.encryptAndHash(hs.ss, spk);
    this.mixKey(hs.ss, this.dh(hs.s.privateKey, hs.re));
    const ciphertext = this.encryptAndHash(hs.ss, payload);
    const ne = this.createEmptyKey();
    const messageBuffer: MessageBuffer = {ne, ns, ciphertext};
    const { cs1, cs2 } = this.split(hs.ss);

    return { h: hs.ss.h, messageBuffer, cs1, cs2 };
  }

  private readMessageA(hs: HandshakeState, message: MessageBuffer): bytes {
    if (isValidPublicKey(message.ne)) {
      hs.re = message.ne;
    }

    this.mixHash(hs.ss, hs.re);
    return this.decryptAndHash(hs.ss, message.ciphertext);
  }

  private readMessageB(hs: HandshakeState, message: MessageBuffer): bytes {
    if (isValidPublicKey(message.ne)) {
      hs.re = message.ne;
    }

    this.mixHash(hs.ss, hs.re);
    if (!hs.e) {
      throw new Error("Handshake state `e` param is missing.");
    }
    this.mixKey(hs.ss, this.dh(hs.e.privateKey, hs.re));
    const ns = this.decryptAndHash(hs.ss, message.ns);
    if (ns.length === 32 && isValidPublicKey(message.ns)) {
      hs.rs = ns;
    }
    this.mixKey(hs.ss, this.dh(hs.e.privateKey, hs.rs));
    return this.decryptAndHash(hs.ss, message.ciphertext);
  }

  private readMessageC(hs: HandshakeState, message: MessageBuffer) {
    const ns = this.decryptAndHash(hs.ss, message.ns);
    if (ns.length === 32 && isValidPublicKey(message.ns)) {
      hs.rs = ns;
    }

    if (!hs.e) {
      throw new Error("Handshake state `e` param is missing.");
    }
    this.mixKey(hs.ss, this.dh(hs.e.privateKey, hs.rs));

    const plaintext = this.decryptAndHash(hs.ss, message.ciphertext);
    const { cs1, cs2 } = this.split(hs.ss);

    return { h: hs.ss.h, plaintext, cs1, cs2 };
  }

  public initSession(initiator: boolean, prologue: bytes32, s: KeyPair): NoiseSession {
    const psk = this.createEmptyKey();
    const rs = Buffer.alloc(32); // no static key yet
    let hs;

    if (initiator) {
      hs = this.initializeInitiator(prologue, s, rs, psk);
    } else {
      hs = this.initializeResponder(prologue, s, rs, psk);
    }

    return {
      hs,
      i: initiator,
      mc: new BN(0),
    };
  }

  public sendMessage(session: NoiseSession, message: bytes): MessageBuffer {
    let messageBuffer: MessageBuffer;
    if (session.mc.eqn(0)) {
      messageBuffer = this.writeMessageA(session.hs, message);
    } else if (session.mc.eqn(1)) {
      messageBuffer = this.writeMessageB(session.hs, message);
    } else if (session.mc.eqn(2)) {
      const { h, messageBuffer: resultingBuffer, cs1, cs2 } = this.writeMessageC(session.hs, message);
      messageBuffer = resultingBuffer;
      session.h = h;
      session.cs1 = cs1;
      session.cs2 = cs2;
      delete session.hs;
    } else if (session.mc.gtn(2)) {
      if (session.i) {
        if (!session.cs1) {
          throw new Error("CS1 (cipher state) is not defined")
        }

        messageBuffer = this.writeMessageRegular(session.cs1, message);
      } else {
        if (!session.cs2) {
          throw new Error("CS2 (cipher state) is not defined")
        }

        messageBuffer = this.writeMessageRegular(session.cs2, message);
      }
    } else {
      throw new Error("Session invalid.")
    }

    session.mc = session.mc.add(new BN(1));
    return messageBuffer;
  }

  public recvMessage(session: NoiseSession, message: MessageBuffer): bytes {
    let plaintext: bytes;
    if (session.mc.eqn(0)) {
      plaintext = this.readMessageA(session.hs, message);
    } else if (session.mc.eqn(1)) {
      plaintext = this.readMessageB(session.hs, message);
    } else if (session.mc.eqn(2)) {
      const { h, plaintext: resultingPlaintext, cs1, cs2 } = this.readMessageC(session.hs, message);
      plaintext = resultingPlaintext;
      session.h = h;
      session.cs1 = cs1;
      session.cs2 = cs2;
    } else if (session.mc.gtn(2)) {
      if (session.i) {
        if (!session.cs2) {
          throw new Error("CS1 (cipher state) is not defined")
        }
        plaintext = this.readMessageRegular(session.cs2, message);
      } else {
        if (!session.cs1) {
          throw new Error("CS1 (cipher state) is not defined")
        }
        plaintext = this.readMessageRegular(session.cs1, message);
      }
    } else {
      throw new Error("Session invalid.");
    }

    session.mc = session.mc.add(new BN(1));
    return plaintext;
  }
}

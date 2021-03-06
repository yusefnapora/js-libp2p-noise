import {Buffer} from "buffer";
import {BN} from "bn.js";

import {HandshakeState, MessageBuffer, NoiseSession} from "../@types/handshake";
import {bytes, bytes32} from "../@types/basic";
import {generateKeypair, getHkdf, isValidPublicKey} from "../utils";
import {AbstractHandshake} from "./abstract-handshake";
import {KeyPair} from "../@types/libp2p";


export class IKHandshake extends AbstractHandshake {
  public initSession(initiator: boolean, prologue: bytes32, s: KeyPair, rs: bytes32): NoiseSession {
    const psk = this.createEmptyKey();

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
      const { messageBuffer: mb, h, cs1, cs2 } = this.writeMessageB(session.hs, message);
      messageBuffer = mb;
      session.h = h;
      session.cs1 = cs1;
      session.cs2 = cs2;
    } else if (session.mc.gtn(1)) {
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
      const { plaintext: pt, h, cs1, cs2 } = this.readMessageB(session.hs, message);
      plaintext = pt;
      session.h = h;
      session.cs1 = cs1;
      session.cs2 = cs2;
      delete session.hs;
    } else if (session.mc.gtn(1)) {
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

  private writeMessageA(hs: HandshakeState, payload: bytes): MessageBuffer {
    hs.e = generateKeypair();
    const ne = hs.e.publicKey;
    this.mixHash(hs.ss, ne);
    this.mixKey(hs.ss, this.dh(hs.e.privateKey, hs.rs));
    const spk = Buffer.from(hs.s.publicKey);
    const ns = this.encryptAndHash(hs.ss, spk);

    this.mixKey(hs.ss, this.dh(hs.s.privateKey, hs.rs));
    const ciphertext = this.encryptAndHash(hs.ss, payload);

    return { ne, ns, ciphertext };
  }

  private writeMessageB(hs: HandshakeState, payload: bytes) {
    hs.e = generateKeypair();
    const ne = hs.e.publicKey;
    this.mixHash(hs.ss, ne);

    this.mixKey(hs.ss, this.dh(hs.e.privateKey, hs.re));
    this.mixKey(hs.ss, this.dh(hs.e.privateKey, hs.rs));
    const ciphertext = this.encryptAndHash(hs.ss, payload);
    const ns = this.createEmptyKey();
    const messageBuffer: MessageBuffer = {ne, ns, ciphertext};
    const { cs1, cs2 } = this.split(hs.ss);

    return { messageBuffer, cs1, cs2, h: hs.ss.h }
  }

  private readMessageA(hs: HandshakeState, message: MessageBuffer): bytes {
    if (isValidPublicKey(message.ne)) {
      hs.re = message.ne;
    }

    this.mixHash(hs.ss, hs.re);
    this.mixKey(hs.ss, this.dh(hs.s.privateKey, hs.re));
    const ns = this.decryptAndHash(hs.ss, message.ns);
    if (ns.length === 32 && isValidPublicKey(message.ns)) {
      hs.rs = ns;
    }
    this.mixKey(hs.ss, this.dh(hs.s.privateKey, hs.rs));
    return this.decryptAndHash(hs.ss, message.ciphertext);
  }

  private readMessageB(hs: HandshakeState, message: MessageBuffer) {
    if (isValidPublicKey(message.ne)) {
      hs.re = message.ne;
    }

    this.mixHash(hs.ss, hs.re);
    if (!hs.e) {
      throw new Error("Handshake state should contain ephemeral key by now.");
    }
    this.mixKey(hs.ss, this.dh(hs.e.privateKey, hs.re));
    this.mixKey(hs.ss, this.dh(hs.s.privateKey, hs.re));
    const plaintext = this.decryptAndHash(hs.ss, message.ciphertext);
    const { cs1, cs2 } = this.split(hs.ss);

    return { h: hs.ss.h, plaintext, cs1, cs2 };
  }

  private initializeInitiator(prologue: bytes32, s: KeyPair, rs: bytes32, psk: bytes32): HandshakeState {
    const name = "Noise_IK_25519_ChaChaPoly_SHA256";
    const ss = this.initializeSymmetric(name);
    this.mixHash(ss, prologue);
    this.mixHash(ss, rs);
    const re = Buffer.alloc(32);

    return { ss, s, rs, re, psk };
  }

  private initializeResponder(prologue: bytes32, s: KeyPair, rs: bytes32, psk: bytes32): HandshakeState {
    const name = "Noise_IK_25519_ChaChaPoly_SHA256";
    const ss = this.initializeSymmetric(name);
    this.mixHash(ss, prologue);
    this.mixHash(ss, s.publicKey);
    const re = Buffer.alloc(32);

    return { ss, s, rs, re, psk };
  }
}

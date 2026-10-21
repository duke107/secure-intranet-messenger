import { x25519 } from '@noble/curves/ed25519.js';
import { MlKem768 } from 'mlkem';
import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';

const mlkem768 = new MlKem768();

export interface LocalMessage {
  id: string;
  senderId: string;
  recipientId: string | null;
  groupId: string | null;
  payload: string;
  status: string;
  timestamp: string;
  replyTo?: any;
  is_forwarded?: boolean;
  is_deleted?: boolean;
}

interface CryptoDB extends DBSchema {
  keys: {
    key: string;
    value: {
      type: string;
      privKey: Uint8Array;
      pubKey: Uint8Array | number[]; // For mlkem, might be Uint8Array
      id?: string;
    };
  };
  messages: {
    key: string;
    value: LocalMessage;
  };
}

let dbPromise: Promise<IDBPDatabase<CryptoDB>>;

export function initCryptoDB(userId: string) {
  dbPromise = openDB<CryptoDB>(`nexus_crypto_${userId}`, 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('keys', { keyPath: 'id' });
      }
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains('messages')) {
          db.createObjectStore('messages', { keyPath: 'id' });
        }
      }
    },
  });
  return dbPromise;
}

function toHex(arr: Uint8Array) {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}


export async function generateAndUploadKeysIfNeeded(token: string) {
  const db = await dbPromise;
  
  // Check if identity key exists
  let identityKey = await db.get('keys', 'identity');
  if (!identityKey) {
    console.log("Generating new Identity Key...");
    const x25519Priv = x25519.utils.randomSecretKey();
    const x25519Pub = x25519.getPublicKey(x25519Priv);
    
    const [mlkemPub, mlkemPriv] = await mlkem768.generateKeyPair();
    
    identityKey = {
      id: 'identity',
      type: 'identity',
      privKey: new Uint8Array([...x25519Priv, ...mlkemPriv]),
      pubKey: { x: toHex(x25519Pub), m: toHex(mlkemPub) } as any
    };
    await db.put('keys', identityKey);
  }

  // Check signed pre-key
  let signedPreKey = await db.get('keys', 'signed_pre_key');
  if (!signedPreKey) {
    console.log("Generating new Signed Pre-Key...");
    const x25519Priv = x25519.utils.randomSecretKey();
    const x25519Pub = x25519.getPublicKey(x25519Priv);
    
    const [mlkemPub, mlkemPriv] = await mlkem768.generateKeyPair();
    
    // In a real implementation we would sign this with the identity key
    // We will just mock the signature for now
    const signature = 'mock_signature_from_identity_key';
    
    signedPreKey = {
      id: 'signed_pre_key',
      type: 'signed_pre_key',
      privKey: new Uint8Array([...x25519Priv, ...mlkemPriv]),
      pubKey: { x: toHex(x25519Pub), m: toHex(mlkemPub), sig: signature } as any
    };
    await db.put('keys', signedPreKey);
  }

  // Check one-time keys
  const allKeys = await db.getAll('keys');
  const oneTimeKeys = allKeys.filter(k => k.type === 'one_time');
  
  let oneTimeKeysPayload = [];
  if (oneTimeKeys.length < 20) {
    console.log(`Generating 100 new One-Time Keys (currently have ${oneTimeKeys.length})...`);
    for (let i = 0; i < 100; i++) {
      const id = crypto.randomUUID();
      const x25519Priv = x25519.utils.randomSecretKey();
      const x25519Pub = x25519.getPublicKey(x25519Priv);
      const [mlkemPub, mlkemPriv] = await mlkem768.generateKeyPair();
      
      const keyObj = {
        id,
        type: 'one_time',
        privKey: new Uint8Array([...x25519Priv, ...mlkemPriv]),
        pubKey: { x: toHex(x25519Pub), m: toHex(mlkemPub) } as any
      };
      await db.put('keys', keyObj);
      oneTimeKeysPayload.push({
        id,
        x25519_pub: keyObj.pubKey.x,
        mlkem_pub: keyObj.pubKey.m
      });
    }
    
    // Upload to server
    console.log("Uploading keys to server...");
    const payload = {
        identityKey: { x25519_pub: (identityKey.pubKey as any).x, mlkem_pub: (identityKey.pubKey as any).m },
        signedPreKey: { x25519_pub: (signedPreKey.pubKey as any).x, mlkem_pub: (signedPreKey.pubKey as any).m, signature: (signedPreKey.pubKey as any).sig },
        oneTimeKeys: oneTimeKeysPayload
    };
    
    const res = await fetch('http://localhost:8080/api/keys/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        console.error("Failed to upload keys", await res.text());
    }
  }
}

export async function clearCryptoDB() {
    if (dbPromise) {
        const db = await dbPromise;
        const keys = await db.getAllKeys('keys');
        const tx = db.transaction('keys', 'readwrite');
        for (const key of keys) {
            await tx.store.delete(key);
        }
        await tx.done;
        console.warn('Crypto DB wiped.');
    }
}

export async function saveLocalMessage(msg: LocalMessage) {
    if (!dbPromise) return;
    const db = await dbPromise;
    await db.put('messages', msg);
}

export async function getLocalMessage(id: string): Promise<LocalMessage | undefined> {
    if (!dbPromise) return undefined;
    const db = await dbPromise;
    return await db.get('messages', id);
}

export async function getAllLocalMessages(): Promise<LocalMessage[]> {
    if (!dbPromise) return [];
    const db = await dbPromise;
    return await db.getAll('messages');
}

export async function updateLocalMessageStatus(id: string, status: string) {
    if (!dbPromise) return;
    const db = await dbPromise;
    const msg = await db.get('messages', id);
    if (msg) {
        msg.status = status;
        await db.put('messages', msg);
    }
}

export async function markLocalMessageDeleted(id: string) {
    if (!dbPromise) return;
    const db = await dbPromise;
    const msg = await db.get('messages', id);
    if (msg) {
        msg.is_deleted = true;
        await db.put('messages', msg);
    }
}

export async function clearLocalChatMessages(chatId: string, isGroup: boolean) {
    if (!dbPromise) return;
    const db = await dbPromise;
    const all = await db.getAll('messages');
    const tx = db.transaction('messages', 'readwrite');
    for (const m of all) {
        if (isGroup && m.groupId === chatId) {
            await tx.store.delete(m.id);
        } else if (!isGroup && (m.senderId === chatId || m.recipientId === chatId)) {
            await tx.store.delete(m.id);
        }
    }
    await tx.done;
}

function fromHex(str: string) {
  const arr = new Uint8Array(str.length / 2);
  for (let i = 0; i < str.length; i += 2) {
    arr[i / 2] = parseInt(str.substring(i, i + 2), 16);
  }
  return arr;
}

export async function encryptFileBuffer(buffer: ArrayBuffer): Promise<{
    encryptedBuffer: ArrayBuffer;
    fileKeyHex: string;
    ivHex: string;
}> {
    const fileKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const aesKey = await crypto.subtle.importKey(
        "raw",
        fileKeyBytes,
        { name: "AES-GCM" },
        false,
        ["encrypt"]
    );

    console.log(`[🔒 FILE ENCRYPT] Encrypting ${buffer.byteLength} bytes of file payload with AES-256-GCM...`);
    const encryptedBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        aesKey,
        buffer
    );
    console.log(`[🛡️ FILE SECURED] File successfully encrypted into ${encryptedBuffer.byteLength} bytes.`);

    return {
        encryptedBuffer,
        fileKeyHex: toHex(fileKeyBytes),
        ivHex: toHex(iv)
    };
}

export async function decryptFileBuffer(
    encryptedBuffer: ArrayBuffer,
    fileKeyHex: string,
    ivHex: string
): Promise<ArrayBuffer> {
    const fileKeyBytes = fromHex(fileKeyHex);
    const iv = fromHex(ivHex);

    const aesKey = await crypto.subtle.importKey(
        "raw",
        fileKeyBytes,
        { name: "AES-GCM" },
        false,
        ["decrypt"]
    );

    console.log(`[🔓 FILE DECRYPT] Decrypting ${encryptedBuffer.byteLength} bytes with AES-256-GCM...`);
    const decryptedBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        aesKey,
        encryptedBuffer
    );
    console.log(`[✅ FILE READY] File decrypted successfully!`);
    return decryptedBuffer;
}

export async function fetchPreKeys(userId: string, token: string) {
    const res = await fetch(`http://localhost:8080/api/keys/fetch/${userId}`, {
        headers: { "Authorization": `Bearer ${token}` }
    });
    if (!res.ok) throw new Error("Failed to fetch keys");
    return await res.json();
}

export async function encryptMessage(plaintext: string, recipientKeys: any) {
    const targetKeyBundle = recipientKeys.oneTimeKey || recipientKeys.signedPreKey || recipientKeys.identityKey;
    if (!targetKeyBundle) throw new Error("No recipient keys found");

    const recipientX25519Pub = fromHex(targetKeyBundle.x25519_pub);
    const recipientMlkemPub = fromHex(targetKeyBundle.mlkem_pub);

    const x25519Priv = x25519.utils.randomSecretKey();
    const x25519Pub = x25519.getPublicKey(x25519Priv);
    const ecdhSecret = x25519.getSharedSecret(x25519Priv, recipientX25519Pub);

    const [mlkemCiphertext, mlkemSecret] = await mlkem768.encap(recipientMlkemPub);

    const combined = new Uint8Array(ecdhSecret.length + mlkemSecret.length);
    combined.set(ecdhSecret, 0);
    combined.set(mlkemSecret, ecdhSecret.length);
    
    console.log(`[🔒 ENCRYPTING] Starting Hybrid Post-Quantum Encryption...`);
    console.log(`[+] ECDH (X25519) Secret Generated: ${ecdhSecret.length} bytes`);
    console.log(`[+] ML-KEM (Kyber) Secret Encapsulated: ${mlkemSecret.length} bytes`);

    const sharedSecretHash = await crypto.subtle.digest("SHA-256", combined);
    const hashHex = Array.from(new Uint8Array(sharedSecretHash)).map(b => b.toString(16).padStart(2, '0')).join('');
    
    console.log(`[🔑 KDF] Derived AES-GCM 256-bit Key Hash: ${hashHex.substring(0, 16)}...`);
    const aesKey = await crypto.subtle.importKey(
        "raw", 
        sharedSecretHash, 
        { name: "AES-GCM" }, 
        false, 
        ["encrypt"]
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertextBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, encoded);

    console.log(`[🛡️ SECURED] Plaintext encrypted into ${ciphertextBuf.byteLength} bytes of unreadable ciphertext!`);

    return {
        ciphertext: toHex(new Uint8Array(ciphertextBuf)),
        iv: toHex(iv),
        ephemeral_x25519_pub: toHex(x25519Pub),
        mlkem_ciphertext: toHex(mlkemCiphertext),
        used_one_time_key_id: recipientKeys.oneTimeKey?.id || null
    };
}

export async function decryptMessage(
    payload: {
        ciphertext: string,
        iv: string,
        ephemeral_x25519_pub: string,
        mlkem_ciphertext: string,
        used_one_time_key_id: string | null
    }
) {
    const db = await dbPromise;
    let localKeys;

    if (payload.used_one_time_key_id) {
        localKeys = await db.get("keys", payload.used_one_time_key_id);
        if (!localKeys) throw new Error("CRITICAL: One-Time Key not found! It was likely wiped or overwritten.");
    } else {
        localKeys = await db.get("keys", "signed_pre_key");
        if (!localKeys) {
            localKeys = await db.get("keys", "identity");
        }
    }
    if (!localKeys) throw new Error("No decryption keys available");

    const myX25519Priv = localKeys.privKey.slice(0, 32); 
    const myMlkemPriv = localKeys.privKey.slice(32); 

    console.log(`[🔓 DECRYPTING] Incoming Encrypted Message Received!`);
    
    const ephemeralX25519Pub = fromHex(payload.ephemeral_x25519_pub);
    const mlkemCiphertext = fromHex(payload.mlkem_ciphertext);

    const ecdhSecret = x25519.getSharedSecret(myX25519Priv, ephemeralX25519Pub);
    console.log(`[+] ECDH (X25519) Secret Reconstructed: ${ecdhSecret.length} bytes`);
    
    const mlkemSecret = await mlkem768.decap(mlkemCiphertext, myMlkemPriv);
    console.log(`[+] ML-KEM (Kyber) Secret Decapsulated: ${mlkemSecret.length} bytes`);

    const combined = new Uint8Array(ecdhSecret.length + mlkemSecret.length);
    combined.set(ecdhSecret, 0);
    combined.set(mlkemSecret, ecdhSecret.length);

    const sharedSecretHash = await crypto.subtle.digest("SHA-256", combined);
    const hashHex = Array.from(new Uint8Array(sharedSecretHash)).map(b => b.toString(16).padStart(2, '0')).join('');
    console.log(`[🔑 KDF] Reconstructed AES-GCM 256-bit Key Hash: ${hashHex.substring(0, 16)}...`);

    const aesKey = await crypto.subtle.importKey(
        "raw", 
        sharedSecretHash, 
        { name: "AES-GCM" }, 
        false, 
        ["decrypt"]
    );

    const iv = fromHex(payload.iv);
    const ciphertextBuf = fromHex(payload.ciphertext);
    try {
        const decryptedBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertextBuf);

        if (payload.used_one_time_key_id) {
            await db.delete("keys", payload.used_one_time_key_id);
            console.log(`[🔥 BURNED] One-Time Key consumed and permanently deleted.`);
        }

        const plaintext = new TextDecoder().decode(decryptedBuf);
        console.log(`[✅ SUCCESS] Ciphertext successfully decrypted back to plaintext!`);
        return plaintext;
    } catch (e: any) {
        const hashHex = Array.from(new Uint8Array(sharedSecretHash)).map(b => b.toString(16).padStart(2, '0')).join('');
        throw new Error(`AES-GCM Failed! Hash: ${hashHex.substring(0, 16)}... | IV: ${payload.iv.substring(0, 8)}...`);
    }
}


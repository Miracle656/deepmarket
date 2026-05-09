// Adapter that wraps dapp-kit's signPersonalMessage into a Signer-compatible
// object for the Sui Stack Messaging SDK's relayer transport.
//
// Adapted from the canonical chat-app reference at
// MystenLabs/sui-stack-messaging/chat-app/src/lib/dapp-kit-signer.ts
//
// Supports Ed25519, Secp256k1, Secp256r1, zkLogin, and multisig wallets by
// lazily extracting the public key from the first signature when the wallet
// doesn't expose publicKey upfront.

import { Signer, parseSerializedSignature } from '@mysten/sui/cryptography';
import type { PublicKey, SignatureScheme } from '@mysten/sui/cryptography';
import { publicKeyFromRawBytes, publicKeyFromSuiBytes } from '@mysten/sui/verify';
import { toBase64 } from '@mysten/sui/utils';

export type SignPersonalMessageFn = (args: {
    message: Uint8Array;
}) => Promise<{ signature: string }>;

export class DappKitSigner extends Signer {
    readonly #address: string;
    #publicKey: PublicKey | null;
    readonly #signPersonalMessage: SignPersonalMessageFn;

    constructor(opts: {
        address: string;
        publicKeyBytes?: Uint8Array;
        signPersonalMessage: SignPersonalMessageFn;
    }) {
        super();
        this.#address = opts.address;
        this.#publicKey = opts.publicKeyBytes?.length
            ? publicKeyFromSuiBytes(opts.publicKeyBytes)
            : null;
        this.#signPersonalMessage = opts.signPersonalMessage;
    }

    async sign(_bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
        throw new Error(
            'DappKitSigner.sign() is not supported. Use signPersonalMessage() instead.'
        );
    }

    override async signPersonalMessage(
        bytes: Uint8Array
    ): Promise<{ bytes: string; signature: string }> {
        const { signature } = await this.#signPersonalMessage({ message: bytes });

        // Lazily resolve public key from the first signature.
        if (!this.#publicKey) {
            const parsed = parseSerializedSignature(signature);
            if ('publicKey' in parsed && parsed.publicKey) {
                this.#publicKey = publicKeyFromRawBytes(
                    parsed.signatureScheme,
                    parsed.publicKey
                );
            }
        }

        return { bytes: toBase64(bytes), signature };
    }

    getKeyScheme(): SignatureScheme {
        if (!this.#publicKey) return 'ED25519';
        const flag = this.#publicKey.flag();
        if (flag === 0x00) return 'ED25519';
        if (flag === 0x01) return 'Secp256k1';
        return 'Secp256r1';
    }

    getPublicKey(): PublicKey {
        if (!this.#publicKey) {
            throw new Error(
                'Public key not yet available. It is resolved on first signPersonalMessage call.'
            );
        }
        return this.#publicKey;
    }

    override toSuiAddress(): string {
        return this.#address;
    }
}

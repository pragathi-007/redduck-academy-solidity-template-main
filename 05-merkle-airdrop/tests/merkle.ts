// Merkle tree utilities for the airdrop. Implement these so the roots and proofs
// you produce verify against your contract's claim() / _verify(). You choose the
// leaf hash format, the node-combination rule, and the odd-layer convention -
// whatever you pick must match what the contract recomputes.

import { keccak256, encodePacked, concat, type Address, type Hex } from "viem";

export interface AirdropEntry {
  account: Address;
  amount: bigint;
}

// Hash one airdrop entry into a leaf.
export function hashLeaf(entry: AirdropEntry): Hex {
  return keccak256(encodePacked(["address", "uint256"], [entry.account, entry.amount]));
}

function hashPair(a: Hex, b: Hex): Hex {
  const [first, second] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([first, second]));
}

export class MerkleTree {
  layers: Hex[][];

  constructor(entries: AirdropEntry[]) {
    if (entries.length === 0) {
      throw new Error("MerkleTree requires at least one entry");
    }

    const leaves = entries.map(hashLeaf);
    this.layers = [leaves];

    let currentLayer = leaves;
    while (currentLayer.length > 1) {
      const nextLayer: Hex[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1]));
        } else {
          // Odd-layer convention: promote the unpaired last node up
          nextLayer.push(currentLayer[i]);
        }
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  getRoot(): Hex {
    const topLayer = this.layers[this.layers.length - 1];
    return topLayer[0];
  }

  get root(): Hex {
    return this.getRoot();
  }

  // The sibling hashes from the leaf at `index` up to the root.
  getProof(index: number): Hex[] {
    if (index < 0 || index >= this.layers[0].length) {
      throw new Error("Leaf index out of bounds");
    }

    const proof: Hex[] = [];
    let idx = index;

    for (let layerIdx = 0; layerIdx < this.layers.length - 1; layerIdx++) {
      const layer = this.layers[layerIdx];
      const isRightNode = idx % 2 === 1;
      const siblingIdx = isRightNode ? idx - 1 : idx + 1;

      if (siblingIdx < layer.length) {
        proof.push(layer[siblingIdx]);
      }

      idx = Math.floor(idx / 2);
    }

    return proof;
  }
}

# Third-Party Components

Uses the official legacy @sqds/sdk, @solana/web3.js and LiteSVM, plus bn.js and bs58, under their upstream licenses. Dependency sources and versions are recorded in package-lock.json.

Squads v3 source: https://github.com/Squads-Protocol/squads-mpl
Program: SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu
Pinned deployed ELF SHA-256: 757fb8ad1ebce912970d59c2022f1fd0711aa46280e59c37ca8ad56a91e685a2

No Squads program binary is distributed in this repository. Setup reads the public deployed ProgramData account, verifies its hash and stores the binary locally for synthetic rehearsal; it is gitignored. The source link is not a reproducible-build attestation.

The app and fixtures were extracted from a local operations prototype. Publication fixtures use fresh synthetic public keys, with no private keys retained or shipped. This repository is not endorsed by Squads or Solana.

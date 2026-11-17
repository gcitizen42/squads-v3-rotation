# Security

This is unaudited local transaction-preparation software. Independently verify the selected multisig, complete final roster, threshold, program, instruction data and wallet fees before approving. Never enter a seed or private key.

Do not expose the localhost server publicly or bind it to a shared interface. Do not publish your generated outputs, wallet receipts, credentials or diagnostic logs.

The backend only reads public chain state and prepares unsigned transactions/public local plans. Your wallet alone authorizes sends. A lost response may still mean the transaction landed: check wallet history and chain state before retrying.

Report vulnerabilities privately to the repository owner rather than publishing credentials or exploitable live multisig details. Synthetic tests are not an audit.

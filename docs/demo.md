# Submission demo: 2 minutes 49 seconds

The [final MP4](../output/submission/Ploby-Track-B-Demo.mp4) contains English captions and demonstrates Track B through two separate out-of-scope agent runs, each with a visible stop and an on-chain record. [YouTube upload copy](../output/submission/YouTube-upload.txt) includes chapters and the trust disclosures. Upload it as Unlisted, then submit its public watch link.

| Time | Demonstration |
| --- | --- |
| 00:00 | Shared project scope, budget and demo signatures |
| 00:10 | Kiln plan; over-cap stock images blocked; next planned offer approved |
| 00:40 | Purchase report, receipt submission, client review and settlement |
| 01:12 | Confirmed 24,200 TestKRW transaction |
| 01:21 | Boundary run A1: unlisted keyboard vendor |
| 01:42 | Boundary run A2: 203,500 KRW total over the 200,000 KRW cap |
| 01:58 | Both recorded stops, their log lines and public-chain events |
| 02:08 | Client pause and stopped agent task |
| 02:24 | Independent verification and portable evidence |
| 02:41 | Matched inference benchmark and honest energy assumptions |

## Rehearsal

Start the API (`python3 -m escrow.server`) and Vite, then run `python3 harness/demo_setup.py` to create a signed and funded test project. Install `requirements.txt` first if demonstrating optional wallet approvals. Pick English in the UI. The demo role selector is not authentication.

For the normal task, select only the Gabia domain, Adobe 40-image pack, Adobe 10-image pack and Coupang keyboard offers. Ask: “Set up a one-year domain, get 40 stock photos (use the 10-image plan as a fallback), and buy an office keyboard.” Show the plan and the rule behind each decision. Report the domain purchase, submit the Gabia receipt, switch to the client and approve its settlement. Wait for the chain receipt.

Prepare a **fresh project with the same policy** for the two boundary runs. Previously requested documents are already allocated, even if blocked; reusing the old project can make `allocation` the primary rule rather than the boundary being demonstrated.

1. Select only the Coupang keyboard and ask “Request this mechanical keyboard for our project office.” Show the live plan and `BLOCK · Vendor`.
2. Select only the Adobe 40-image pack and ask “Request the 40-image stock-photo pack for the website.” Show the second plan and `BLOCK · Per-purchase limit`.
3. Open Verify and expand the details. Both stops must appear, each with its own log line and chain link. This boundary-only project has no completed payment; its report must say so.

In the workflow project, the client can pause new commitments and the contractor can rerun the task. Even if a duplicate allocation is the first failed rule, the failed state rule must stop remaining purchases. Existing accepted commitments can still be settled.

Export the workflow ZIP and run `python3 verify.py` outside the application. With demo signatures, the expected result is `incomplete`, not fully verified. Present the public transaction, document hashes and reconstructed payment separately from human-approval authenticity. See [submission.md](submission.md) for exact final logs, transactions and limitations.

A cache replay is labeled as such and makes no new inference call. A failed plan files nothing; an unreadable document cannot silently become an approval. With no chain network, show the archived report and disclose that current chain verification is unavailable.

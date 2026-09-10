# Local application policies

## Scope
Make Access → Policies operate without Host by exposing existing local application policy controls.

## Direction
Code-led Operate extension of existing Access panels; reuse Identity registration editor, native fields and role checkboxes. No new visual world or comp.

## Content
Exact application, organization, callbacks and per-scope roles. Unchecked roles deny, including owners. Registration is not consent.
The stable public application ID wraps beneath its name using the existing `access-ref` treatment. The introduction is limited to 62ch. Saving a changed policy invalidates existing application grants and requires a new sign-in and explicit consent.

## Interaction
One shared editor and encrypted store, explicit save/reload, existing draft and focus recovery. No second policy evaluator.

## States
Loading, safe read errors, no applications, disabled applications and policy edits. Host policies remain independently optional.
Disabled applications remain listed with disabled editors. A failed directory refresh retains visible subjects but disables editing; reload and local IAM change notifications refresh the directory.

## Proof
All eight real Chromium local IAM journeys pass, including encrypted persistence and policy-change enforcement at desktop/mobile widths, plus four focused panel tests. The final Pages rerun passes 3564 tests across 292 files in 70.92s; this record does not claim full browser IAM completion or full repository verification.

The independent finish reviewer returned `ship` after both findings were resolved: stable public application references and measured introduction prose. The main agent inspected all four fresh captures: `apps/pages/.impeccable/review/local-policy-1280.png`, `local-policy-390.png`, `local-policy-top-1280.png`, and `local-policy-top-390.png` (all under the same review directory). The verdict covers this Access reuse surface only. No second editor, encrypted store, role evaluator, design token, or component example was introduced.

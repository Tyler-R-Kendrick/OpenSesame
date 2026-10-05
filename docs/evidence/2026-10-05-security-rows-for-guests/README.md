# Security › Duress and Travel for a guest with no key yet

Settings › Security walked as a guest (front door → Skip), same walk on the base
build and on this branch, at 1280×900 and 390×844.

| | before | after |
|---|---|---|
| Desktop | [before-desktop.png](before-desktop.png) | [after-desktop.png](after-desktop.png) |
| Phone | [before-phone.png](before-phone.png) | [after-phone.png](after-phone.png) |

Measured from the browser (`.panel h2` headings, and `#duress-after-key,
#duress-profiles` / `#travel-after-key, #travel` row counts):

- before, both widths: sections `Unlock methods, Second step`; Duress rows 0; Travel rows 0
- after, both widths: sections `Unlock methods, Second step, Duress, Travel`; Duress rows 1; Travel rows 1

The "before" captures end at Second step: the page was scrolled to its bottom in both builds.

Also walked, not pictured: J-DURESS-GUEST (Add → key sheet → PIN → the real
Duress and Travel panels replace the placeholders, the Duress sheet lists its
modes) fails on the base build and passes here; J-DURESS asserts a decoy is
drawn neither the real nor the placeholder rows.

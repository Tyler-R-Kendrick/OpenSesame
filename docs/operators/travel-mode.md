# Travel mode

Design: [ADR 0143](../adr/0143-travel-mode.md). Research:
[`docs/research/travel-mode.md`](../research/travel-mode.md).

Travel mode lets you cross a border carrying only the vaults that are safe
to carry. The other vaults leave the device whole and come back afterwards.

## Before you leave

1. Open a vault you will carry. The open vault always travels.
2. Go to **Settings › Security › Travel** and press **Turn on travel mode**.
   A sheet opens with the list of vaults. Switch on **Safe for travel** for
   each vault you will carry. Any vault you leave off stays home.
3. Press **Pack the rest for travel**. Nothing is removed yet.
4. Save the **travel bundle** somewhere other than this device, such as
   another computer, a drive that stays home, or a cloud folder you will not
   open on the trip.
5. Write down the **return code** shown in the sheet and leave it at home or
   with someone you trust. Do not photograph it with this device.
6. Tick both boxes and press **Take them off this device**. The receipt says
   how many vaults and files left. If a file could not be removed, the
   receipt says so and the packed bundle stays in the sheet: press the same
   key again to finish. If the page is closed first, the Travel panel lists
   the **leftovers** (files with no header, which can never be opened here)
   and **Clear leftover files** removes them. Your bundle holds all of them.

## Coming home

Open one of your vaults, then press **Turn off travel mode** in the Travel
panel. In the sheet, choose the bundle and type the return code, then press
**Open the bundle**. Letter case, dashes, and the characters 0/O and 1/I
don't matter. Check the preview, then press **Bring them home**. If you
sealed a new vault on the trip under the same id, it is left alone and
reported as occupied. A vault a departure left half removed comes home
whole.

If the vaults had given sites permission to sign in without asking, the
preview names those sites. They get that permission back only if you tick
**Let these sites in again**. Otherwise each site asks again the next time.
Tick it only for a bundle you made yourself. Sites you had blocked stay
blocked either way.

## Leaving items at home

Travel mode above moves whole vaults. If you must unlock the vault you carry,
choose which of **its items** stay home instead ([ADR 0171](../adr/0171-hide-items-while-traveling.md);
audit in [`travel-hidden-items.md`](../research/travel-hidden-items.md)).

1. Open the vault. In **Settings › Security › Travel** press **Choose items to
   leave at home**. Switch on **Stays home** for each item. Press **Pack the
   items for travel**. Nothing is removed yet.
2. Save the **travel bundle** and write down the **return code**, as above.
   Tick all three boxes, the third being that other devices, exports and
   backups still hold these items and that losing the bundle and the code
   loses them here.
3. Press **Take them out of this vault**. The items leave in one step. Their
   activity lines and retired-password digests go with them, and nothing is
   put in the trash or written as a deletion.
4. To bring them back, open the vault and press **Turn off travel mode**,
   choose the bundle and type the code. The preview lists the items. Press
   **Bring them back**. They return with their own ids, dates and folders;
   returning twice changes nothing.

It refuses, and says why, while any of these is on:

- a **backup target**, a **history backup** (one bound to a remote, or any
  history entry held on this device), or a queued offline write for this vault
  (each keeps an older copy or would hand the items back);
- a **paired drive** (its next sync would bring the items back);
- a **share** of the item (end it first);
- a duress incident, a guest or decoy session, or a browser that keeps no
  files.

Files (attachments) and drops cannot be left home on their own; they are not
offered. Use whole-vault travel for them.

Nothing on the device lists what is away: the panel looks the same whether
items are hidden or not, and the choice is not remembered. That is on
purpose, and it means you must keep your own record of what you left.

**Limits.** This is not protection from coercion; you may be made to say items
are hidden, or to give up the bundle and the code. Copies on other devices,
exports and backups you made remain. A merge or an import of an older export
that you do later can bring items back. Removal is the browser's, not a disk
wipe. A connector bound to a hidden item stops working until it returns.

## What this does not do

- **It is not a forensic wipe.** The browser deletes its files. That is not
  the same as sanitising the disk.
- **Other copies are not touched.** Git backup history, Host sync, Identity
  project memberships, exports and OS backups of the browser profile can
  still hold the departed vaults.
- **Carrying the code undoes it.** So does carrying the bundle together with
  the code.
- **It does not work under duress, in a guest session, or where the browser
  keeps no files.** Travel mode refuses in each of these cases.

## Remembered choices

The vaults you mark **Safe for travel** are remembered on the device across
reloads (ADR 0155), so the choice is made once, at home. A vault that has left
the device, or been deleted, drops out of the list when it is read. A departure
does not clear the marks of the vaults that stayed.

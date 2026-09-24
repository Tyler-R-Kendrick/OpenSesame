# Travel mode

Design: [ADR 0140](../adr/0140-travel-mode.md). Research:
[`docs/research/travel-mode.md`](../research/travel-mode.md).

Travel mode lets you cross a border carrying only the vaults that are safe
to carry. The other vaults leave the device whole and come back afterwards.

## Before you leave

1. Open a vault you will carry. The open vault always travels.
2. Go to **Settings › Vaults › Travel** and switch on **Safe for travel**
   for each vault you will carry. Any vault you leave off stays home.
3. Press **Pack the rest for travel**. Nothing is removed yet.
4. Save the **travel bundle** somewhere other than this device, such as
   another computer, a drive that stays home, or a cloud folder you will not
   open on the trip.
5. Write down the **return code** and leave it at home or with someone you
   trust. Do not photograph it with this device.
6. Tick both boxes and press **Take them off this device**. The receipt says
   how many vaults and files left. If a file could not be removed, the
   receipt says so.

## Coming home

Open one of your vaults, then press **Bring vaults home** in the Travel
panel. Choose the bundle and type the return code. Letter case, dashes, and
the characters 0/O and 1/I don't matter. Check the preview, then press
**Bring them home**. If you sealed a new vault on the trip under the same id,
it is left alone and reported as occupied.

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

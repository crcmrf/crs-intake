# CRS Intake

A small web app for recording incoming CRS material by truck. Staff enter the date, carrier, truck rego and (optionally) bin number and location. The app looks for a saved sheet with those details in a GitHub repository — if one exists it opens it, otherwise it starts a new one. Entries are added with the **+** button and saved straight back to GitHub.

Runs entirely in the browser — no server needed. Host it free on GitHub Pages.

## How it works

1. **Lookup** – date is pre-filled with today. Carrier and rego are required, bin no and location are optional.
2. **Match** – the details make up the file name, e.g.
   `data/2026-10-06/smith-transport__123abc__bin-7__loc-cairns.json`
   Same details → same sheet. (Matching ignores case and spacing in the rego.)
3. **Add entries** – tap **+**, choose the material:
   - Aluminium → *Aluminium* column, asks for bag number
   - PET - Clear, PET - Colour, HDPE, LPB, Steel → *Other* column, asks for bag number
   - Glass → *Glass* column, asks for IBC # and optional weight
   "Add + another" keeps the same material selected for scanning bags quickly.
4. **Tick off** – each entry has a tick box. Ticking it crosses the entry out (it stays on the sheet) and saves who-knows-when in the Excel export. Untick to undo.
5. **Edit details** – tap the header box or **✎ Edit details** to change the carrier, rego, bin no, location or manifest no. The date can't be changed. Changing carrier/rego/bin/location moves the sheet to its new file name and leaves a pointer behind, so looking up the old details still opens the right sheet.
6. **Manifest No** – shown under Location; usually added later via Edit details.
7. **Edit / weigh later** – tap any filled row to edit it, add the glass weight, or delete it. Glass without a weight shows "to weigh".
5. **Saving** – every change is saved as a commit to the data repo. If two devices edit the same sheet at once, the changes are merged automatically.
6. **Excel** – the ⬇ Excel button on a sheet downloads that truck's bags and IBCs as an .xlsx file.
7. **Print** – prints the sheet on one A4 portrait page in the same layout as the paper form. Long loads are shrunk to fit; glass still "to weigh" prints blank so the weight can be written in.

## Home page
Below the lookup form:
- **Recent loads** – every load in the chosen period, newest first, with bag counts per material. Tap one to open it.
- **By location** – a table of loads and bags per material for each location, with totals. Loads saved without a location are grouped as "No location".
- **Export to Excel** – downloads the period as an .xlsx file with two tabs: *By location* (the totals table) and *Loads* (every load, one row each).
- **Period dropdown** – 7 days, 14 days, month, 3, 6 or 12 months (remembered on each device).

These read small monthly summary files (`data/_index/2026-10.json`) that are updated each time a sheet is saved, so the page stays quick even over 12 months. If a load is ever missing from the list, tap **"Rebuild the summary for this period"** at the bottom of the page.

## Setup (about 10 minutes)

### 1. Create two repositories
| Repo | Visibility | Purpose |
|---|---|---|
| `crs-intake` | Public | The website (these files) |
| `crs-intake-data` | **Private** | Where sheets are saved |

Keeping data in a separate private repo means the records aren't public, while the website can still be hosted free on GitHub Pages. (You *can* use one repo for both — just know the data would then be public.)

In `crs-intake-data`, make sure there's at least one commit (tick "Add a README" when creating it).

### 2. Upload the website
Edit `config.js` with your GitHub username and data repo name, then upload all files to `crs-intake`.

Enable hosting: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root → Save**. Your site will be at `https://<username>.github.io/crs-intake/`.

### 3. Create an access token
GitHub → your avatar → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
- **Repository access:** Only select repositories → `crs-intake-data`
- **Permissions → Repository permissions → Contents:** Read and write
- Set an expiry you're comfortable with (you'll need to renew it).

### 4. Connect each device
Open the site, tap **⚙ Settings**, paste the token, tap **Test connection**, then **Save**. The token is stored only in that device's browser.

## Connecting to your own website
- **Custom domain:** In `crs-intake` → Settings → Pages → Custom domain (e.g. `intake.yourcompany.com.au`), then add the CNAME record with your DNS provider.
- **Link or embed:** link to the Pages URL from your site, or embed it:
  ```html
  <iframe src="https://<username>.github.io/crs-intake/" style="width:100%;height:900px;border:0"></iframe>
  ```

## Monthly reports
A scheduled GitHub job in the **data repo** creates an Excel file of the By location totals for each month, on the 1st of the following month. The files show under **Monthly reports** on the home page. Setup steps are in the `crs-intake-data-repo` folder's README.

## Files
`index.html`, `styles.css`, `app.js` (the app), `xlsx.js` (builds the Excel files in the browser – no outside library), `config.js` (your repo settings and the carrier/location dropdown lists).

## Data format
Each sheet is a JSON file:
```json
{
  "version": 1,
  "meta": { "date": "2026-10-06", "carrier": "Smith Transport", "rego": "123ABC", "bin": "7", "location": "Cairns" },
  "entries": [
    { "id": "…", "material": "Aluminium", "bag": "1042", "createdAt": "…", "updatedAt": "…" },
    { "id": "…", "material": "Glass", "ibc": "G-17", "weight": "", "createdAt": "…", "updatedAt": "…" }
  ],
  "deleted": []
}
```
The full history of every change is in the data repo's commit log.

## Security notes
- Anyone holding the token can edit the data repo, so only put it on work devices and keep its scope limited to the data repo.
- If a device is lost, revoke the token on GitHub and issue a new one.
- For a large team, the next step up is a small backend (e.g. a Cloudflare Worker) that holds the token so staff never see it.

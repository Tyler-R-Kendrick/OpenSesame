/** Synthetic exports in the vendors' documented portable file shapes. */
const protonZip =
  "UEsDBBQAAAAIAAAATl0vQ9jAkgAAANQAAAAVAAAAUHJvdG9uIFBhc3MvZGF0YS5qc29uPcyxDoJADAbgV7l0PgdXRjc34qhxaKCXkNxdSa8ohNy7WxAdmr9pv3YFyp0so1IPTcBYyMMLp6gFmhXCMOsktLUZkyVchN+FxNE8shjyMCglw48ViqKaOXvoUXE70mXcjjLb3EMixd/meNcKK2fHIcQhk7tfW3fgPRq4EUb3VafAklD/eBfVQ8dZKat9rbU+rT5QSwECFAMUAAAACAAAAE5dL0PYwJIAAADUAAAAFQAAAAAAAAAAAAAAgAEAAAAAUHJvdG9uIFBhc3MvZGF0YS5qc29uUEsFBgAAAAABAAEAQwAAAMUAAAAAAA==";

function loginFixture(origin) {
  const login = {
    name: "Imported origin login",
    username: "offline-fixture-user",
    password: "browser-offline-fixture-password",
    notes: "Imported locally from Bitwarden JSON",
  };
  return {
    providerId: "bitwarden",
    format: "bitwarden-json",
    name: login.name,
    notes: login.notes,
    file: {
      name: "bitwarden-browser.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          encrypted: false,
          folders: [],
          items: [
            {
              id: "export-login",
              type: 1,
              name: login.name,
              notes: login.notes,
              login: {
                username: login.username,
                password: login.password,
                uris: [{ uri: origin }],
              },
            },
          ],
        }),
      ),
    },
  };
}

export function backupImportFixtures(origin) {
  return [loginFixture(origin), ...noteFixtures()];
}

function noteFixtures() {
  return [
    {
      providerId: "1password",
      format: "1password-csv",
      name: "1Password offline note",
      notes: "CSV note imported locally",
      file: {
        name: "onepassword-browser.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          "title,password,username,url,notes,archived,tags\n1Password offline note,,,,CSV note imported locally,false,browser\n",
        ),
      },
    },
    {
      providerId: "proton-pass",
      format: "protonpass-json",
      name: "Proton offline JSON note",
      notes: "Real Proton-format JSON note",
      file: {
        name: "proton-browser.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            encrypted: false,
            vaults: {
              fixture: {
                name: "Browser exports",
                items: [
                  {
                    state: 1,
                    data: {
                      type: "note",
                      metadata: {
                        name: "Proton offline JSON note",
                        note: "Real Proton-format JSON note",
                      },
                      content: {},
                    },
                  },
                ],
              },
            },
          }),
        ),
      },
    },
    {
      providerId: "proton-pass",
      format: "protonpass-json",
      name: "Proton offline ZIP note",
      notes: "Real Proton-format offline note",
      // A real deflated ZIP generated with Python's standard zipfile module,
      // containing exactly Proton Pass/data.json with one synthetic note.
      file: {
        name: "proton-browser.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(protonZip, "base64"),
      },
    },
    {
      providerId: "byo-secret-backend",
      format: "env-file",
      name: "BROWSER_OFFLINE_SECRET",
      notes: "",
      file: {
        name: "browser.env",
        mimeType: "text/plain",
        buffer: Buffer.from(
          "BROWSER_OFFLINE_SECRET=browser-env-fixture-value\n",
        ),
      },
    },
  ];
}

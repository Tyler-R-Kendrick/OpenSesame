/**
 * A relying party with a change-password form and a login form, as markup a
 * jsdom page can load. It keeps the one thing a rotation is about — the
 * account's password — and lets a test see what the site itself holds.
 */
export const RP = "https://rp.example";

export class Site {
  password: string;
  readonly username = "ada@example.com";
  /** Every submit the site received, as the site saw it. */
  readonly submits: { path: string; fields: Record<string, string> }[] = [];

  constructor(password: string) {
    this.password = password;
  }

  render(path: string, signedIn: boolean, search = ""): string {
    if (path === "/account/password") {
      return `<!doctype html><html><body>
        <form id="change">
          <input id="current" name="current" type="password" />
          <input id="new" name="new" type="password" />
          <input id="confirm" name="confirm" type="password" />
          <button id="go" type="submit">Change</button>
        </form>
        <script>window.secretInPage = "never read";</script>
        <!-- a comment -->
      </body></html>`;
    }
    if (path === "/account/password/done") {
      return `<html><body><p id="done">Changed</p></body></html>`;
    }
    if (path === "/login") {
      return `<html><body>${
        signedIn
          ? '<p id="welcome">Welcome</p>'
          : `${search.includes("denied") ? '<p id="denied">Denied</p>' : ""}<form id="login">
              <input id="user" name="user" type="text" />
              <input id="pass" name="pass" type="password" />
              <button id="signin" type="submit">Sign in</button>
            </form>`
      }</body></html>`;
    }
    return "<html><body><p>not found</p></body></html>";
  }

  /** What a submit of the form on `path` does. Returns the next path. */
  submit(path: string, fields: Record<string, string>): string {
    this.submits.push({ path, fields });
    if (path === "/account/password") {
      const ok =
        fields.current === this.password && fields.new === fields.confirm;
      if (ok) this.password = fields.new ?? this.password;
      return ok ? "/account/password/done" : "/account/password?error=1";
    }
    if (path === "/login") {
      return fields.user === this.username && fields.pass === this.password
        ? "/login?ok=1"
        : "/login?denied=1";
    }
    return path;
  }
}

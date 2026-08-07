export type PagesSettings = {
  hostApi: string;
  identityApi: string;
  operatorToken: string;
};

const KEY = "opensesame.pages.settings.v1";

const defaults: PagesSettings = {
  hostApi: "http://127.0.0.1:8787",
  identityApi: "http://127.0.0.1:8788",
  operatorToken: "",
};

export function loadSettings(): PagesSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<PagesSettings>;
    return {
      hostApi: parsed.hostApi?.trim() || defaults.hostApi,
      identityApi: parsed.identityApi?.trim() || defaults.identityApi,
      operatorToken: parsed.operatorToken ?? "",
    };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(next: PagesSettings): void {
  localStorage.setItem(KEY, JSON.stringify(next));
}

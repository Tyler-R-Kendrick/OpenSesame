import { IconAlert, IconCheck } from "../../components/Icons.js";
export type Flash = { tone: "ok" | "err" | "warn"; text: string };
export function SecretConfigFlash({ flash }: { flash: Flash | null }) {
  return (
    <>
      {flash ? (
        <p
          className={`note note--${flash.tone === "ok" ? "ok" : flash.tone === "warn" ? "warn" : "err"}`}
          role={flash.tone === "err" ? "alert" : "status"}
        >
          {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
          <span>{flash.text}</span>
        </p>
      ) : null}
    </>
  );
}

import { h, clear, icon, toast } from "./ui.js";
import { isMuted, toggleMute } from "./sound.js";
import { isDark, toggleTheme } from "./theme.js";

export function brand(small = false) {
  return h(
    "a",
    { class: `brand${small ? " sm" : ""}`, href: "/", "aria-label": "WikiDash home" },
    h("span", { class: "b-wiki" }, "Wiki"),
    h("span", { class: "b-dash" }, "Dash"),
  );
}

export function inviteLink(code) {
  return `${location.origin}/?room=${code}`;
}

export async function copyInvite(code) {
  const link = inviteLink(code);
  try {
    await navigator.clipboard.writeText(link);
    toast("Invite link copied. Send it to your friends.", "ok");
  } catch {
    window.prompt("Copy this invite link:", link);
  }
}

export function roomChip(ctx) {
  return h(
    "button",
    { class: "room-chip", type: "button", title: "Copy invite link", onclick: () => copyInvite(ctx.S.code) },
    h("span", { class: "rc-label" }, "Party"),
    h("span", { class: "rc-code" }, ctx.S.code),
    icon("copy", 15),
  );
}

export function connDot() {
  return h("span", { class: "conn", title: "Connection" }, h("span", { class: "conn-dot" }), h("span", { class: "conn-text" }));
}

/** Sound and dark mode switches, shown in every top bar. */
export function toolButtons() {
  const snd = h("button", { class: "icon-btn sm tool", type: "button", title: "Sound on or off", "aria-label": "Sound on or off" });
  const thm = h("button", { class: "icon-btn sm tool", type: "button", title: "Light or dark mode", "aria-label": "Light or dark mode" });
  const paint = () => {
    clear(snd).append(icon(isMuted() ? "mute" : "volume", 16));
    clear(thm).append(icon(isDark() ? "sun" : "moon", 16));
  };
  snd.addEventListener("click", () => (toggleMute(), paint()));
  thm.addEventListener("click", () => (toggleTheme(), paint()));
  paint();
  return h("span", { class: "tools" }, snd, thm);
}

// Distinguishes "the user clicked Sign out" from "the session was lost". Both
// flip the session to unauthenticated; only the second should send people back
// to the page they were on (?next=). Without this, the layout guard and the
// sign-out handler race to navigate and the next person to sign in on this tab
// can land on the previous user's file.
let signingOut = false;

export function beginSignOut() {
  signingOut = true;
}

export function isSigningOut() {
  return signingOut;
}

export function endSignOut() {
  signingOut = false;
}

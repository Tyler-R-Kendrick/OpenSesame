import {
  verifyAuthenticationResponse as verifyAuthenticationResponseImpl,
  verifyRegistrationResponse as verifyRegistrationResponseImpl,
} from "@simplewebauthn/server";

export const simpleWebAuthnSeams = {
  verifyRegistrationResponse: verifyRegistrationResponseImpl,
  verifyAuthenticationResponse: verifyAuthenticationResponseImpl,
};

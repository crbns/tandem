declare const process: { env: { CONVEX_SITE_URL?: string } };

const issuer = process.env.CONVEX_SITE_URL;
if (!issuer) throw new Error("CONVEX_SITE_URL is required to configure Convex Auth");

export default {
  providers: [
    {
      domain: issuer,
      applicationID: "convex",
    },
  ],
};

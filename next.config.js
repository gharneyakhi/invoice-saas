/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
    // PNG/JPG export renders via sharp in a route handler — keep its
    // native bindings out of the webpack bundle.
    serverComponentsExternalPackages: ["sharp"],
  },
};
module.exports = nextConfig;

import type { MetadataRoute } from "next";

// Home-screen installs launch at Portfolio, not whatever tab was open
// when the icon was added.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "InvestApp",
    short_name: "InvestApp",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [{ src: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  };
}

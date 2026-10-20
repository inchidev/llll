# Interface direction

L4 uses an achromatic palette, a four-L mark, bundled Geist under SIL OFL 1.1, small corner radii and clear typography. Preserve the current composition while fixing observed layout and interaction defects.

The landing explains communities, shows the interface, and offers Cloudflare or experimental VPS deployment. The Shell displays a flat list of independent Servers and embeds each Server's own Client. Accounts and content remain local to each Server. Native iOS/macOS packaging is frozen.

Inherited product screenshots are sample content and must be disclosed until replaced by current L4 captures. The landing has no live sandbox until a current fixture is explicitly provided. Do not claim current browser/device acceptance from prototype critique scores or archived screenshots.

Review the first community journey, empty states, navigation, composer and settings at phone and desktop widths as described in the roadmap. Record actual evidence for the new source instead of copying prototype design scores.

## Shared controls

`packages/client-ui/theme.css` owns the Shell and Server font, surfaces, text contrast, focus, reduced-motion and forced-color rules. `packages/client-ui/theme.ts` configures their Nuxt UI tabs. Use `l4-segmented-track` and `l4-segmented-item` for custom segments; active tabs and app links use an inverted surface in both color modes. Keep semantic status colors for errors, warnings and provider state.

Authentication keeps the Server's own name and desktop introduction. On phones the compact brand header leaves the form immediately available. Avoid decorative shapes, dot fields and glass cards. Long settings panes scroll independently; save bars put their message above the actions on narrow screens. Label every switch, including those beside a separate visible description.

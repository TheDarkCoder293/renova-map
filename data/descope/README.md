# Renova Descope Widget Styling

This package is for the widget-only version of the Renova login styling.
It is intended to make the Descope auth widget feel like the right-side login panel you approved:
- white/clean auth surface
- Renova purple as the primary action color
- terracotta secondary accents
- warm gold support accent
- serif-style heading feel
- stronger CTA hierarchy

## What To Use

Use the existing Descope flows you already have:
- `sign-in` for a pure login widget
- `sign-up` for a pure account creation widget
- `sign-up-or-in` for a combined auth widget

For your stated goal, `sign-in` is the closest match to the "Welcome Back" login card.

## Theme Files

For a Descope Console import, use:
- [renova-theme-import.json](/Users/phoenixbrown/Downloads/Renova/data/descope/renova-theme-import.json)

For MCP or API-based mutation, use:
- [renova-apply-project-theme.json](/Users/phoenixbrown/Downloads/Renova/data/descope/renova-apply-project-theme.json)

The import JSON is a best-effort Descope theme object built to match the documented export/import wrapper shape.
The apply-project-theme JSON is the brand-input payload for `applyProjectTheme`.

## Important Limitation

This only styles the widget itself.
It does not create the full split-page layout from the mock.
You said you will design the surrounding page and embed the widget inside it, which is the right approach.

## Recommended Page Structure

Build your page shell yourself, then embed the Descope widget in the right-side card area.
Use:
- your own `Welcome Back` heading
- your own subtitle
- your own `Create account` link outside or below the widget if needed

That gives you exact page control while Descope handles the secure auth UI.

## If You Import In The Descope Website

1. Open the Styles page in Descope.
2. Use the import arrow at the top right.
3. Import [renova-theme-import.json](/Users/phoenixbrown/Downloads/Renova/data/descope/renova-theme-import.json).
4. Apply that style to the flow/widget you want to use.

If the console rejects the import file, switch to the Styles GUI/Code Mode and use the values below manually.

## If You Can Apply Theme Via MCP Later

Run Descope `flows_write.applyProjectTheme` with the JSON payload from:
- [renova-apply-project-theme.json](/Users/phoenixbrown/Downloads/Renova/data/descope/renova-apply-project-theme.json)

## If You Apply It Manually In Descope

Use these values:
- Primary: `#675196`
- Secondary: `#bf5848`
- Surface: `#e0915a`
- Warning/accent: `#eac247`
- Headline font: `Georgia`
- Body font: `Segoe UI`
- Logo: `https://cdn.prod.website-files.com/6a4a69dad9b0b223793dbe6b/6a4f706126da02351f8bd72d_RED%20%20(3).svg`

## Which Flow To Embed

For the closest match to your mock:
1. Use the `sign-in` flow in the widget.
2. Put `Welcome Back` and the supporting copy in your page shell, not inside Descope.
3. Put `Create an account` below the widget and link that action to your `sign-up` widget/page.

That will look closer than forcing a combined flow to act like a custom-designed marketing card.

## Working Link Pattern

Use one page and switch flow with query params:
- Sign in page mode:
	- /descope-login-embed.html?flow=sign-in&redirect=https%3A%2F%2Frenova.help%2F
- Sign up page mode:
	- /descope-login-embed.html?flow=sign-up&redirect=https%3A%2F%2Frenova.help%2Fwelcome

The embed page now defaults to `sign-in` and supports aliases:
- `signin` or `login` => `sign-in`
- `signup` or `register` => `sign-up`

## If Sign Up Still Fails

Check these in Descope:
1. Flow ID is exactly `sign-up` (case-sensitive).
2. The flow has a success path ending in logged-in action.
3. Email template and provider are enabled for the sign-up method you selected.
4. Approved domains include the host where your widget is embedded.
5. You are linking to `?flow=sign-up` (not `sign-up-or-in`) from your Create Account CTA.

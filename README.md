<br />
<div align="center">
  <a href="https://github.com/franciscoBSalgueiro/en-croissant">
    <img width="115" height="115" src="https://github.com/franciscoBSalgueiro/en-croissant/blob/master/src-tauri/icons/icon.png" alt="Logo">
  </a>

<h3 align="center">En Croissant</h3>

  <p align="center">
    The Ultimate Chess Toolkit
    <br />
    <a href="https://www.encroissant.org"><strong>encroissant.org</strong></a>
    <br />
    <br />
    <a href="https://discord.gg/tdYzfDbSSW">En Croissant Official Discord Server</a>
    .
    <a href="https://www.encroissant.org/docs">Explore the docs</a>
  </p>
</div>

---

> **Notice: This is a personally maintained fork of [En Croissant](https://github.com/franciscoBSalgueiro/en-croissant).
> This version may diverge from the original and will likely be modified in the future.
> Please support and credit the original creators!**

---

En-Croissant is an open-source, cross-platform chess GUI that aims to be powerful, customizable and easy to use.


## Features

- Store and analyze your games from [lichess.org](https://lichess.org) and [chess.com](https://chess.com)
- Multi-engine analysis. Supports all UCI engines
- Prepare a repertoire and train it with spaced repetition
- Simple engine and database installation and management
- Absolute or partial position search in the database

<img src="https://github.com/franciscoBSalgueiro/encroisssant-site/blob/master/assets/showcase.webp" />

## Building from source

Refer to the [Tauri documentation](https://tauri.app/v1/guides/getting-started/prerequisites) for the requirements on your platform.

En-Croissant uses pnpm as the package manager for dependencies. Refer to the [pnpm install instructions](https://pnpm.io/installation) for how to install it on your platform.

```bash
git clone https://github.com/0x29a-blink/en-croissant
cd en-croissant
pnpm install
pnpm build
```

The built app can be found at `src-tauri/target/release`

## Donate

Please support the original creators of En Croissant by donating [here](https://encroissant.org/support).
All donations go directly to the original En Croissant team.

## Contributing

For contributing to this project please refer to the [Contributing guide](./CONTRIBUTING.md).

# Updating TunnelSats

This document provides instructions for updating the TunnelSats package for StartOS.

## General Procedure

1. **Review Upstream Changes**:
   - Check [TunnelSats](https://tunnelsats.com) release notes and upstream service changes.

2. **Update SDK & Dependencies**:
   - Ensure `@start9labs/start-sdk` is up to date:
     ```bash
     npm update @start9labs/start-sdk
     ```

3. **Verify Version Graph & Migrations**:
   - Update `startos/versions/current.ts` with the new version and release notes in all supported locales (`en_US`, `es_ES`, `de_DE`, `pl_PL`, `fr_FR`).
   - If migrations are needed, implement `up` migration in `startos/versions/index.ts`.

4. **Test & Build**:
   - Run unit and integration tests:
     ```bash
     npm run test:all
     ```
   - Build package:
     ```bash
     rm -rf javascript && make javascript/index.js
     ```

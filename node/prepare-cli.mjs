#!/usr/bin/env node
import { preparePanorama } from "./preparation.mjs";
try { process.exitCode = preparePanorama(process.argv.slice(2)).exitCode; }
catch (error) { console.error(`prepare-panorama: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }

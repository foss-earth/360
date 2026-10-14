#!/usr/bin/env node
import { prepareSphere } from "./preparation.mjs";
try { process.exitCode = prepareSphere(process.argv.slice(2)).exitCode; }
catch (error) { console.error(`prepare-panorama: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }

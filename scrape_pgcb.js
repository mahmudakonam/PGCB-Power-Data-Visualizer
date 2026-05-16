#!/usr/bin/env node
/**
 * PGCB Power Generation Data Scraper
 * ====================================
 * Scrapes hourly power generation data from the PGCB ERP website:
 *   https://erp.powergrid.gov.bd/w/generations/view_generations_bn
 *
 * The website uses Bengali numerals and text. This script converts
 * everything to English and saves to CSV format matching pgcb_data.csv.
 *
 * Usage:
 *   node scrape_pgcb.js              # Scrape page 1 only (latest data)
 *   node scrape_pgcb.js --pages 10   # Scrape first 10 pages
 *   node scrape_pgcb.js --all        # Scrape ALL pages (full backfill)
 *   node scrape_pgcb.js --from 50    # Start from page 50 (resume)
 *   node scrape_pgcb.js --all --from 100  # Full backfill starting from page 100
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Allow self-signed / untrusted SSL certificates (PGCB ERP has one)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Configuration ───────────────────────────────────────────────────
const BASE_URL = 'https://erp.powergrid.gov.bd/w/generations/view_generations_bn';
const OUTPUT_FILE = path.join(__dirname, 'pgcb_live_data.csv');
const CSV_HEADER = 'datetime,generation_mw,demand_mw,load_shedding,gas,liquid_fuel,coal,hydro,solar,wind,india_bheramara_hvdc,india_tripura,india_adani,nepal,remarks';
const DELAY_MS = 800; // Delay between requests to be respectful to the server
const MAX_RETRIES = 3;

// ─── Bengali Numeral Conversion ──────────────────────────────────────
const BENGALI_DIGITS = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9'
};

function toEnglishDigits(str) {
  if (!str) return '';
  return String(str).replace(/[০-৯]/g, d => BENGALI_DIGITS[d] || d);
}

// ─── Bengali Remarks Translation ─────────────────────────────────────
function translateRemarks(text) {
  if (!text) return '';
  text = text.trim();
  if (text === 'সন্ধ্যা পিক') return 'Evening_Peak';
  if (text === 'ডে পিক') return 'Day_Peak';
  if (text === '') return '';
  // Return the original text converted to English numerals if not a known phrase
  return toEnglishDigits(text);
}

// ─── Date/Time Conversion ────────────────────────────────────────────
/**
 * Convert Bengali date "১৪-০৫-২০২৬" and time "১৯:৩০:০০"
 * to CSV format "5/14/26 19:30" matching pgcb_data.csv
 *
 * Special: 24:00:00 = midnight end of day → becomes 0:00 of next day
 */
function convertDateTime(bengaliDate, bengaliTime) {
  const dateStr = toEnglishDigits(bengaliDate); // e.g., "14-05-2026"
  const timeStr = toEnglishDigits(bengaliTime); // e.g., "19:30:00"

  const dateParts = dateStr.split('-');
  if (dateParts.length !== 3) return null;

  let day = parseInt(dateParts[0], 10);
  let month = parseInt(dateParts[1], 10);
  let year = parseInt(dateParts[2], 10);

  const timeParts = timeStr.split(':');
  let hours = parseInt(timeParts[0], 10);
  let minutes = parseInt(timeParts[1] || '0', 10);

  // Handle 24:00 → next day 0:00
  if (hours === 24) {
    hours = 0;
    // Advance to next day
    const d = new Date(year, month - 1, day + 1);
    day = d.getDate();
    month = d.getMonth() + 1;
    year = d.getFullYear();
  }

  // Format: M/D/YY H:MM (matching existing CSV)
  const yy = String(year).slice(-2);
  const formattedTime = `${hours}:${String(minutes).padStart(2, '0')}`;

  return `${month}/${day}/${yy} ${formattedTime}`;
}

// ─── HTML Parsing ────────────────────────────────────────────────────
/**
 * Parse a single page's HTML and extract generation data rows
 */
function parsePage(html) {
  const $ = cheerio.load(html);
  const rows = [];

  // Find all data rows in the table body
  $('table.table-bordered tbody tr').each((i, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 13) return; // Skip rows that don't have enough columns

    const bengaliDate = $(tds[0]).text().trim();
    const bengaliTime = $(tds[1]).text().trim();
    const datetime = convertDateTime(bengaliDate, bengaliTime);

    if (!datetime) return; // Skip invalid rows

    const generationMW = toEnglishDigits($(tds[2]).text().trim());
    const gas = toEnglishDigits($(tds[3]).text().trim());
    const liquidFuel = toEnglishDigits($(tds[4]).text().trim());
    const coal = toEnglishDigits($(tds[5]).text().trim());
    const hydro = toEnglishDigits($(tds[6]).text().trim());
    const solar = toEnglishDigits($(tds[7]).text().trim());
    const wind = toEnglishDigits($(tds[8]).text().trim());
    const indiaHVDC = toEnglishDigits($(tds[9]).text().trim());
    const indiaTripura = toEnglishDigits($(tds[10]).text().trim());
    const indiaAdani = toEnglishDigits($(tds[11]).text().trim());
    const nepal = toEnglishDigits($(tds[12]).text().trim());
    const remarks = tds.length > 13 ? translateRemarks($(tds[13]).text()) : '';

    rows.push({
      datetime,
      generation_mw: generationMW,
      demand_mw: '', // Not available on website (commented out)
      load_shedding: '', // Not available on website (commented out)
      gas,
      liquid_fuel: liquidFuel,
      coal,
      hydro,
      solar,
      wind,
      india_bheramara_hvdc: indiaHVDC,
      india_tripura: indiaTripura,
      india_adani: indiaAdani,
      nepal,
      remarks
    });
  });

  return rows;
}

/**
 * Get total number of pages from the pagination links
 */
function getTotalPages(html) {
  const $ = cheerio.load(html);
  let maxPage = 1;

  $('ul.pagination .page-link').each((i, el) => {
    const href = $(el).attr('href');
    if (href) {
      const match = href.match(/page=(\d+)/);
      if (match) {
        const page = parseInt(match[1], 10);
        if (page > maxPage) maxPage = page;
      }
    }
    // Also check link text for page numbers
    const text = $(el).text().trim();
    const num = parseInt(text, 10);
    if (!isNaN(num) && num > maxPage) maxPage = num;
  });

  return maxPage;
}

// ─── Fetching ────────────────────────────────────────────────────────
async function fetchPage(pageNum, retries = MAX_RETRIES) {
  const url = `${BASE_URL}?page=${pageNum}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PGCB-Data-Collector/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'bn-BD,bn;q=0.9,en;q=0.8',
        },
        agent: httpsAgent,
        timeout: 30000,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.text();
    } catch (err) {
      if (attempt < retries) {
        console.log(`  ⚠ Attempt ${attempt} failed for page ${pageNum}: ${err.message}. Retrying...`);
        await sleep(DELAY_MS * 2);
      } else {
        throw err;
      }
    }
  }
}

// ─── Utilities ───────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rowToCSV(row) {
  const fields = [
    row.datetime,
    row.generation_mw,
    row.demand_mw,
    row.load_shedding,
    row.gas,
    row.liquid_fuel,
    row.coal,
    row.hydro,
    row.solar,
    row.wind,
    row.india_bheramara_hvdc,
    row.india_tripura,
    row.india_adani,
    row.nepal,
    row.remarks
  ];
  return fields.join(',');
}

/**
 * Load existing datetimes from the output CSV for deduplication
 */
function loadExistingDatetimes(filepath) {
  const existing = new Set();
  if (!fs.existsSync(filepath)) return existing;

  const content = fs.readFileSync(filepath, 'utf8');
  const lines = content.split('\n');

  for (let i = 1; i < lines.length; i++) { // Skip header
    const line = lines[i].trim();
    if (!line) continue;
    const firstComma = line.indexOf(',');
    if (firstComma > 0) {
      existing.add(line.substring(0, firstComma));
    }
  }

  return existing;
}

/**
 * Parse datetime string to a sortable timestamp
 * Format: "M/D/YY H:MM"
 */
function datetimeToTimestamp(dtStr) {
  const match = dtStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return 0;

  let year = parseInt(match[3], 10);
  year += year < 50 ? 2000 : 1900;

  return new Date(year, parseInt(match[1], 10) - 1, parseInt(match[2], 10),
    parseInt(match[4], 10), parseInt(match[5], 10)).getTime();
}

// ─── Main Scraper ────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const scrapeAll = args.includes('--all');
  const fromIdx = args.indexOf('--from');
  const startPage = fromIdx !== -1 ? parseInt(args[fromIdx + 1], 10) : 1;
  const pagesIdx = args.indexOf('--pages');
  let maxPages = pagesIdx !== -1 ? parseInt(args[pagesIdx + 1], 10) : (scrapeAll ? Infinity : 1);

  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     PGCB Power Generation Data Scraper v1.0         ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  // Step 1: Load existing data for deduplication
  const existingDatetimes = loadExistingDatetimes(OUTPUT_FILE);
  const existingCount = existingDatetimes.size;
  console.log(`📁 Output file: ${OUTPUT_FILE}`);
  console.log(`📊 Existing entries: ${existingCount.toLocaleString()}`);
  console.log('');

  // Step 2: Fetch page 1 to get total pages
  console.log('🔍 Fetching page 1 to discover total pages...');
  let page1Html;
  try {
    page1Html = await fetchPage(1);
  } catch (err) {
    console.error(`❌ Failed to fetch page 1: ${err.message}`);
    process.exit(1);
  }

  const totalPages = getTotalPages(page1Html);
  console.log(`📄 Total pages available: ${totalPages.toLocaleString()}`);

  // Determine scrape range
  const endPage = Math.min(startPage + maxPages - 1, totalPages);
  console.log(`🎯 Scraping pages ${startPage} to ${endPage} (${endPage - startPage + 1} pages)`);
  console.log('');

  // Step 3: Scrape pages and collect rows
  let allNewRows = [];
  let pagesScraped = 0;
  let rowsFound = 0;
  let duplicatesSkipped = 0;
  const startTime = Date.now();

  for (let page = startPage; page <= endPage; page++) {
    const progress = Math.round(((page - startPage + 1) / (endPage - startPage + 1)) * 100);

    try {
      // Use already-fetched page 1 HTML
      const html = page === 1 && startPage === 1 ? page1Html : await fetchPage(page);
      const rows = parsePage(html);

      let pageNew = 0;
      for (const row of rows) {
        if (existingDatetimes.has(row.datetime)) {
          duplicatesSkipped++;
          continue;
        }
        existingDatetimes.add(row.datetime);
        allNewRows.push(row);
        pageNew++;
      }

      rowsFound += rows.length;
      pagesScraped++;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const remaining = page < endPage ?
        (((Date.now() - startTime) / (page - startPage + 1)) * (endPage - page) / 1000).toFixed(0) : 0;

      process.stdout.write(
        `\r  📥 Page ${page}/${endPage} [${progress}%] — ${rows.length} rows (${pageNew} new) ` +
        `| Total: ${allNewRows.length} new | ${elapsed}s elapsed, ~${remaining}s remaining     `
      );

      // Save progress every 50 pages
      if (page % 50 === 0 && allNewRows.length > 0) {
        saveRows(allNewRows, existingCount === 0 && page <= 50);
        console.log(`\n  💾 Progress saved (${allNewRows.length} rows so far)`);
        allNewRows = []; // Clear to avoid re-writing
      }

      // Delay between requests
      if (page < endPage) await sleep(DELAY_MS);

    } catch (err) {
      console.error(`\n  ❌ Error on page ${page}: ${err.message}`);
      console.log(`  ⏩ Skipping page ${page}, continuing...`);
    }
  }

  // Step 4: Save remaining rows
  if (allNewRows.length > 0) {
    saveRows(allNewRows, existingCount === 0 && startPage === 1 && pagesScraped <= 50);
  }

  // Step 5: Summary
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`✅ Scraping complete!`);
  console.log(`   Pages scraped: ${pagesScraped.toLocaleString()}`);
  console.log(`   Rows found: ${rowsFound.toLocaleString()}`);
  console.log(`   New rows added: ${(rowsFound - duplicatesSkipped).toLocaleString()}`);
  console.log(`   Duplicates skipped: ${duplicatesSkipped.toLocaleString()}`);
  console.log(`   Time elapsed: ${totalElapsed}s`);
  console.log(`   Output file: ${OUTPUT_FILE}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
}

/**
 * Save rows to the CSV file (appending or creating)
 */
function saveRows(rows, isNewFile) {
  if (rows.length === 0) return;

  // Sort rows chronologically
  rows.sort((a, b) => datetimeToTimestamp(a.datetime) - datetimeToTimestamp(b.datetime));

  const csvLines = rows.map(rowToCSV);

  if (isNewFile || !fs.existsSync(OUTPUT_FILE)) {
    // Create new file with header
    const content = CSV_HEADER + '\n' + csvLines.join('\n') + '\n';
    fs.writeFileSync(OUTPUT_FILE, content, 'utf8');
  } else {
    // Append to existing file
    const content = '\n' + csvLines.join('\n');
    fs.appendFileSync(OUTPUT_FILE, content, 'utf8');
  }
}

// ─── Run ─────────────────────────────────────────────────────────────
main().catch(err => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

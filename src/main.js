import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';
import * as cheerio from 'cheerio';
// Initialize the Apify SDK
await Actor.init();
/**
 * Extract jobs from JSON-LD structured data (Primary method)
 * Google Jobs and many sites use this schema
 */
async function extractJobsViaJsonLD(page) {
    log.info('Attempting to extract jobs via JSON-LD');
    try {
        const jsonLdScripts = await page.$$eval('script[type="application/ld+json"]', scripts =>
            scripts.map(script => script.textContent)
        );
        const jobs = [];
        for (const scriptContent of jsonLdScripts) {
            try {
                const data = JSON.parse(scriptContent);
                // Handle array of job postings
                if (Array.isArray(data)) {
                    for (const item of data) {
                        if (item['@type'] === 'JobPosting') {
                            jobs.push(parseJobPosting(item));
                        }
                    }
                }
                // Handle single job posting
                else if (data['@type'] === 'JobPosting') {
                    jobs.push(parseJobPosting(data));
                }
                // Handle @graph structure
                else if (data['@graph']) {
                    for (const item of data['@graph']) {
                        if (item['@type'] === 'JobPosting') {
                            jobs.push(parseJobPosting(item));
                        }
                    }
                }
                // Handle ItemList with job postings
                else if (data['@type'] === 'ItemList' && data.itemListElement) {
                    for (const listItem of data.itemListElement) {
                        const item = listItem.item || listItem;
                        if (item['@type'] === 'JobPosting') {
                            jobs.push(parseJobPosting(item));
                        }
                    }
                }
            } catch (parseErr) {
                log.debug(`Failed to parse JSON-LD: ${parseErr.message}`);
            }
        }
        if (jobs.length > 0) {
            log.info(`Extracted ${jobs.length} jobs via JSON-LD`);
        }
        return jobs;
    } catch (error) {
        log.warning(`JSON-LD extraction failed: ${error.message}`);
        return [];
    }
}
/**
 * Parse JobPosting schema to our format
 */
function parseJobPosting(jobData) {
    const hiringOrg = jobData.hiringOrganization || {};
    const jobLocation = jobData.jobLocation || {};
    const address = jobLocation.address || {};
    let location = '';
    if (typeof address === 'string') {
        location = address;
    } else {
        location = [
            address.addressLocality,
            address.addressRegion,
            address.addressCountry
        ].filter(Boolean).join(', ');
    }
    let salary = 'Not specified';
    if (jobData.baseSalary) {
        const baseSalary = jobData.baseSalary;
        if (baseSalary.value) {
            const value = baseSalary.value;
            if (typeof value === 'object') {
                salary = `${value.minValue || ''} - ${value.maxValue || ''} ${baseSalary.currency || ''}`.trim();
            } else {
                salary = `${value} ${baseSalary.currency || ''}`.trim();
            }
        }
    }
    return {
        title: jobData.title || '',
        company: hiringOrg.name || '',
        location: location,
        salary: salary,
        jobType: jobData.employmentType || 'Not specified',
        experience: extractExperience(jobData.description || ''),
        postedDate: jobData.datePosted || '',
        descriptionHtml: jobData.description || '',
        descriptionText: jobData.description ? stripHtml(jobData.description) : '',
        url: jobData.url || '',
        scrapedAt: new Date().toISOString()
    };
}
/**
 * Extract experience from description text
 */
function extractExperience(text) {
    if (!text) return 'Not specified';
    const expMatch = text.match(/(\d+)[\s-]+(?:to|-)[\s]*(\d+)[\s]*(?:years?|yrs?)/i);
    if (expMatch) {
        return `${expMatch[1]}-${expMatch[2]} years`;
    }
    const singleMatch = text.match(/(\d+)[\s]*(?:\+)?[\s]*(?:years?|yrs?)/i);
    if (singleMatch) {
        return `${singleMatch[1]}+ years`;
    }
    if (text.toLowerCase().includes('fresher')) {
        return '0-1 years';
    }
    return 'Not specified';
}
/**
 * Strip HTML tags from string
 */
function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function isLikelyNotFoundPage(titleText, bodyText) {
    const title = (titleText || '').toLowerCase();
    const body = (bodyText || '').toLowerCase();
    return title.includes('404') || body.includes('this page could not be found') || body.includes('page could not be found');
}
function sanitizeHtmlFragment(html) {
    if (!html) return '';
    const $ = cheerio.load(`<div id="__root">${html}</div>`);
    const root = $('#__root');
    // Remove noisy/unsafe content
    root.find('script, style, noscript, svg, img, iframe, canvas, form, input, button, link, meta').remove();
    // Keep only a small allowlist of semantic tags; unwrap everything else
    const allowedTags = new Set(['p', 'ul', 'ol', 'li', 'br', 'strong', 'b', 'em', 'i', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a']);
    root.find('*').each((_, el) => {
        const tag = (el.tagName || '').toLowerCase();
        if (!tag || allowedTags.has(tag)) return;
        $(el).replaceWith($(el).contents());
    });
    // Remove event handlers + styling attributes + classes/ids
    root.find('*').each((_, el) => {
        const attribs = el.attribs || {};
        for (const name of Object.keys(attribs)) {
            const lower = name.toLowerCase();
            if (lower === 'href') continue; // keep links
            if (lower.startsWith('on')) {
                $(el).removeAttr(name);
                continue;
            }
            $(el).removeAttr(name);
        }
    });
    // Remove empty nodes
    root.find('*').each((_, el) => {
        const $el = $(el);
        if ($el.children().length === 0 && !$el.text().trim()) $el.remove();
    });
    return root.html()?.trim() || '';
}
function htmlToReadableText(html) {
    if (!html) return '';
    const $ = cheerio.load(`<div id="__root">${html}</div>`);
    const root = $('#__root');
    root.find('script, style, noscript, svg, img, iframe, canvas, form, input, button, link, meta').remove();
    const lines = [];
    root.find('h1,h2,h3,h4,h5,h6,p,li').each((_, el) => {
        const tag = (el.tagName || '').toLowerCase();
        const t = $(el).text().trim();
        if (!t) return;
        if (tag === 'li') lines.push(`- ${t}`);
        else lines.push(t);
    });
    // Fallback if no semantic blocks present
    if (lines.length === 0) {
        const t = root.text().trim();
        if (t) lines.push(t);
    }
    return lines
        .join('\n')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function extractCleanSectionFromCheerio($, selectors, minTextLength = 30) {
    for (const selector of selectors) {
        const el = $(selector).first();
        if (!el.length) continue;
        const rawText = el.text().trim();
        if (!rawText || rawText.length < minTextLength) continue;
        const rawHtml = el.html()?.trim() || '';
        if (!rawHtml) continue;
        const sanitizedHtml = sanitizeHtmlFragment(rawHtml);
        if (!sanitizedHtml || sanitizedHtml.length > 120000) continue;
        const loweredHtml = sanitizedHtml.toLowerCase();
        if (loweredHtml.includes('__next_f') || loweredHtml.includes('static.naukimg.com') || loweredHtml.includes('_next/static')) {
            continue;
        }
        const text = htmlToReadableText(sanitizedHtml);
        if (/this page could not be found|checking your browser|just a moment/i.test(text)) {
            continue;
        }
        if (text && text.length >= minTextLength) {
            log.info(`✓ Description found: ${selector} (${text.length} chars)`);
            return { descriptionHtml: sanitizedHtml, descriptionText: text };
        }
    }
    return null;
}
// Simple raw extraction without sanitization - fallback when clean method fails
function extractRawDescription($, selectors) {
    for (const selector of selectors) {
        const el = $(selector).first();
        if (!el.length) continue;
        const rawHtml = el.html()?.trim() || '';
        const rawText = el.text().trim();
        if (rawText && rawText.length >= 100 && rawHtml) {
            log.info(`✓ RAW description: ${selector} (${rawText.length} chars)`);
            return {
                descriptionHtml: rawHtml,
                descriptionText: rawText
            };
        }
    }
    return null;
}
function normalizeLocationFromJsonLd(jobLocation) {
    if (!jobLocation) return '';
    const locations = [];
    const addLocation = (loc) => {
        if (!loc) return;
        if (typeof loc === 'string') {
            const t = loc.trim();
            if (t) locations.push(t);
            return;
        }
        const address = loc.address || loc;
        const locality = address.addressLocality;
        const region = address.addressRegion;
        const country = address.addressCountry;
        const parts = [];
        if (Array.isArray(locality)) parts.push(locality.filter(Boolean).join(', '));
        else if (locality) parts.push(locality);
        if (region) parts.push(region);
        if (country) parts.push(country);
        const t = parts.filter(Boolean).join(', ').trim();
        if (t) locations.push(t);
    };
    if (Array.isArray(jobLocation)) jobLocation.forEach(addLocation);
    else addLocation(jobLocation);
    return [...new Set(locations)].join(' | ');
}
function normalizeSalaryFromJsonLd(baseSalary) {
    if (!baseSalary) return '';
    if (typeof baseSalary === 'string') return baseSalary.trim();
    if (typeof baseSalary.value === 'string') return baseSalary.value.trim();
    if (baseSalary.value && typeof baseSalary.value === 'object') {
        const min = baseSalary.value.minValue ?? baseSalary.value.value ?? '';
        const max = baseSalary.value.maxValue ?? '';
        const currency = baseSalary.currency ?? '';
        const unit = baseSalary.value.unitText ?? '';
        return [min && max ? `${min}-${max}` : `${min}${max ? `-${max}` : ''}`, currency, unit].filter(Boolean).join(' ').trim();
    }
    return '';
}
function normalizeExperienceFromJsonLd(experienceRequirements) {
    if (!experienceRequirements) return '';
    if (typeof experienceRequirements === 'string') return experienceRequirements.trim();
    const months = experienceRequirements.monthsOfExperience ?? experienceRequirements.months ?? null;
    if (months == null) return '';
    const m = Number(months);
    if (!Number.isFinite(m) || m <= 0) return '';
    const years = Math.max(0, Math.round((m / 12) * 10) / 10);
    return `${years} years`;
}
async function fetchDescriptionViaPage(jobUrl, page) {
    const context = page.context();
    const primarySelectors = [
        'div[class*="JDC__dang-inner-html"]',
        'div.styles_JDC__dang-inner-html__h0K4t',
        'div[class*="dang-inner-html"]',
    ];
    const descriptionSelectors = [
        'div[class*="JDC__dang-inner-html"]',
        'div[class*="dang-inner-html"]',
        'div.styles_JDC__dang-inner-html__h0K4t',
        'div.styles_detail__U2rw4.styles_dang-inner-html___BCwh',
        '.styles_JDC__dang-inner-html__h0K4t',
        '.styles_dang-inner-html___BCwh',
        'section[class*="job-desc"]',
        'div[class*="jobDescription"]',
        '[data-testid*="job-desc"]',
        '[data-testid*="description"]',
        '.jd-desc',
        '.job-description',
        '.job-desc',
        '.job-details',
        '.jd-cont',
        '.jd-text',
        '.description',
        '.desc',
        '.detail-contents',
        '.dang-inner-html',
        '.text-container',
        '#job_description',
        '#jobDescription',
        '#jobDescriptionText',
        '[class*="job-description"]',
        '[class*="jd"]',
        '[itemprop="description"]',
        'section[class*="jd"]',
        'div[class*="job-description"]',
        'article.jd-info',
        'section.content',
        '.job_description',
        'article .desc',
    ];
    const pageDetail = await context.newPage();
    try {
        log.debug(`Opening detail page with Playwright: ${jobUrl}`);
        await pageDetail.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        // Try to extract from window state variables first
        const windowState = await pageDetail.evaluate(() => {
            try {
                // Check for React/Next.js hydration data
                if (window.__NEXT_DATA__?.props?.pageProps?.job?.description) {
                    return { description: window.__NEXT_DATA__.props.pageProps.job.description };
                }
                // Check for other common state variables
                if (window.jobData?.description) {
                    return { description: window.jobData.description };
                }
            } catch (e) {
                return null;
            }
            return null;
        }).catch(() => null);
        if (windowState?.description) {
            const desc = String(windowState.description);
            const isHtml = /<[^>]+>/.test(desc);
            return {
                descriptionHtml: isHtml ? desc : `<p>${desc}</p>`,
                descriptionText: isHtml ? desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : desc
            };
        }
        await pageDetail.waitForSelector(primarySelectors[0], { timeout: 8000 }).catch(() => {
            log.debug('Primary selector timeout, continuing...');
        });
        await pageDetail.waitForTimeout(1200);
        const html = await pageDetail.content();
        const $ = cheerio.load(html);
        $('p.source, [data-source], .source, .apply-button, .actions, .notclicky').remove();
        log.debug('Trying primary selectors via Playwright...');
        let description = extractCleanSectionFromCheerio($, primarySelectors, 50);
        if (!description) {
            log.debug('Trying fallback selectors via Playwright...');
            description = extractCleanSectionFromCheerio($, descriptionSelectors, 50);
        }
        if (description) {
            log.info(`✓ Successfully extracted via Playwright page (${description.descriptionText.length} chars)`);
        }
        return description;
    } catch (err) {
        log.debug(`Detail page fallback fetch failed: ${err.message}`);
        return null;
    } finally {
        await pageDetail.close().catch(() => { });
    }
}
function parseJobPostingJsonLdCandidate(candidate) {
    if (!candidate || candidate['@type'] !== 'JobPosting') return null;
    const title = candidate.title || candidate.name || '';
    const jobId = candidate.identifier?.value || candidate.identifier?.name || '';
    const company = candidate.hiringOrganization?.name || '';
    const location = normalizeLocationFromJsonLd(candidate.jobLocation);
    const postedDate = candidate.datePosted || '';
    const jobType = Array.isArray(candidate.employmentType)
        ? candidate.employmentType.filter(Boolean).join(', ')
        : (candidate.employmentType || '');
    const experience = normalizeExperienceFromJsonLd(candidate.experienceRequirements);
    const salary = normalizeSalaryFromJsonLd(candidate.baseSalary);
    const skills = Array.isArray(candidate.skills) ? candidate.skills.filter(Boolean).join(', ') : (candidate.skills || '');
    const descriptionRaw = candidate.description ? String(candidate.description) : '';
    // Check if description contains HTML tags or is plain text
    const isHtml = descriptionRaw && /<[^>]+>/.test(descriptionRaw);
    let descriptionHtml = '';
    let descriptionText = '';
    if (descriptionRaw) {
        if (isHtml) {
            // If it's HTML, sanitize and convert to text
            descriptionHtml = sanitizeHtmlFragment(descriptionRaw);
            descriptionText = htmlToReadableText(descriptionRaw);
        } else {
            // If it's plain text, wrap in paragraph tags
            descriptionHtml = `<p>${descriptionRaw}</p>`;
            descriptionText = descriptionRaw;
        }
    }
    return {
        title,
        company,
        location,
        postedDate,
        jobType,
        experience,
        salary,
        tags: skills,
        jobId,
        descriptionHtml,
        descriptionText,
    };
}
/**
 * PLAYWRIGHT-ONLY description fetching
 * Opens detail page with full Playwright navigation to maintain Camoufox stealth
 * NO HTTP methods used - avoids all blocking
 */
async function fetchFullDescription(jobUrl, page) {
    const context = page.context();
    let pageDetail = null;
    try {
        pageDetail = await context.newPage();
        log.debug(`Opening: ${jobUrl}`);
        await pageDetail.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await pageDetail.waitForTimeout(1500);
        // Check for blocks
        const title = await pageDetail.title();
        if (/Just a moment|Access Denied|Cloudflare|Security check/i.test(title)) {
            log.warning(`⚠ Blocked page: ${title}`);
            await pageDetail.close();
            return { blocked: true };
        }
        // Try window state extraction first (fastest)
        const windowData = await pageDetail.evaluate(() => {
            try {
                // Naukri stores data in __NEXT_DATA__
                const nextData = window.__NEXT_DATA__;
                if (nextData?.props?.pageProps?.job?.description) {
                    return nextData.props.pageProps.job.description;
                }
                if (nextData?.props?.pageProps?.jobDetails?.description) {
                    return nextData.props.pageProps.jobDetails.description;
                }
                // Also check raw jobData
                if (window.jobData?.description) {
                    return window.jobData.description;
                }
            } catch (e) { }
            return null;
        }).catch(() => null);
        if (windowData) {
            const desc = String(windowData);
            const isHtml = /<[^>]+>/.test(desc);
            log.info(`✓ Window state (${desc.length} chars)`);
            await pageDetail.close();
            return {
                descriptionHtml: isHtml ? desc : `<p>${desc}</p>`,
                descriptionText: isHtml ? stripHtml(desc) : desc
            };
        }
        // Parse page HTML with cheerio
        const html = await pageDetail.content();
        const $ = cheerio.load(html);
        // Remove noise
        $('script, style, noscript, .apply-button, .actions').remove();
        // Try multiple selectors
        const selectors = [
            'div[class*="JDC__dang-inner-html"]',
            'div[class*="dang-inner-html"]',
            '[itemprop="description"]',
            'section[class*="jobDesc"]',
            '.jd-desc',
            '.job-description',
            '#jobDescriptionText',
        ];
        // Try clean extraction
        let description = extractCleanSectionFromCheerio($, selectors, 30);
        // Try JSON-LD
        if (!description) {
            const jsonLdScripts = $('script[type="application/ld+json"]').map((_, el) => $(el).text()).get();
            for (const script of jsonLdScripts) {
                try {
                    const data = JSON.parse(script);
                    const items = Array.isArray(data) ? data : [data];
                    for (const item of items) {
                        if (item?.['@type'] === 'JobPosting' && item.description) {
                            const desc = String(item.description);
                            const isHtml = /<[^>]+>/.test(desc);
                            log.info(`✓ JSON-LD (${desc.length} chars)`);
                            await pageDetail.close();
                            return {
                                descriptionHtml: isHtml ? sanitizeHtmlFragment(desc) : `<p>${desc}</p>`,
                                descriptionText: isHtml ? htmlToReadableText(desc) : desc
                            };
                        }
                    }
                } catch (e) { }
            }
        }
        // Try raw extraction
        if (!description) {
            description = extractRawDescription($, selectors);
        }
        await pageDetail.close();
        if (description) {
            log.info(`✓ DOM extraction (${description.descriptionText.length} chars)`);
            return description;
        }
        log.warning(`❌ No description found: ${jobUrl}`);
        return null;
    } catch (error) {
        log.error(`Error fetching ${jobUrl}: ${error.message}`);
        if (pageDetail) await pageDetail.close().catch(() => { });
        return null;
    }
}
/**
 * Enrich jobs with full descriptions from detail pages
 * Playwright-only version - no HTTP methods
 */
async function enrichJobsWithFullDescriptions(jobs, page, fullPageDetails = true) {
    if (jobs.length === 0) return jobs;
    if (!fullPageDetails) {
        log.info('fullPageDetails disabled - skipping description enrichment');
        return jobs;
    }
    log.info(`Fetching descriptions for ${jobs.length} jobs...`);
    const enrichedJobs = [];
    let blockedCount = 0;
    // Sequential processing to avoid overwhelming
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (!job.url) {
            enrichedJobs.push(job);
            continue;
        }
        log.debug(`Job ${i + 1}/${jobs.length}: ${job.url}`);
        const fullDesc = await fetchFullDescription(job.url, page);
        if (fullDesc?.blocked) {
            blockedCount++;
            log.warning(`⚠️ Blocked: ${job.url}`);
            enrichedJobs.push(job);
            continue;
        }
        if (fullDesc?.descriptionText) {
            log.info(`✓ Job ${i + 1} enriched (${fullDesc.descriptionText.length} chars)`);
            enrichedJobs.push({
                ...job,
                descriptionHtml: fullDesc.descriptionHtml,
                descriptionText: fullDesc.descriptionText,
            });
        } else {
            log.warning(`✗ No description for job ${i + 1}`);
            enrichedJobs.push(job);
        }
        // Small delay between requests
        if (i < jobs.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    if (blockedCount > 0) {
        log.warning(`${blockedCount} pages blocked`);
    }
    return enrichedJobs;
}
/**
 * Navigate with a retry to avoid transient aborts (NS_ERROR_ABORT, etc.)
 */
async function navigateWithRetry(page, url) {
    const attempts = [
        { waitUntil: 'domcontentloaded', timeout: 30000 },
        { waitUntil: 'load', timeout: 45000 }
    ];
    for (let i = 0; i < attempts.length; i++) {
        try {
            await page.goto(url, attempts[i]);
            return;
        } catch (err) {
            log.warning(`Navigation attempt ${i + 1} failed (${err.message})`);
            if (i === attempts.length - 1) throw err;
            await page.waitForTimeout(2000);
        }
    }
}
async function waitForSearchResultsToRender(page) {
    // On some Naukri listing pages (especially keyword-only), SSR contains skeletons.
    // Wait for client-side rendered links/text to appear before parsing HTML.
    try {
        await page.waitForFunction(() => document.title && document.title.trim().length > 0, { timeout: 8000 });
    } catch {
        // ignore
    }
    const selectors = [
        'a[href*="job-listings"]',
        'a[href^="/job-listings"]',
        'div[class*="tuple"] a[href]',
        'article[class*="tuple"] a[href]',
    ];
    for (const selector of selectors) {
        try {
            await page.waitForSelector(selector, { timeout: 8000 });
            return;
        } catch {
            // try next
        }
    }
    try {
        await page.waitForFunction(() => {
            const nodes = document.querySelectorAll('div[class*="tuple"], article[class*="tuple"]');
            for (const node of nodes) {
                const text = node.innerText || '';
                if (text.trim().length > 40) return true;
            }
            return false;
        }, { timeout: 8000 });
    } catch {
        // ignore
    }
}
/**
 * Build Naukri search URL from input parameters
 */
function buildSearchUrl(input) {
    // If searchUrl is provided, use it directly
    if (input.searchUrl && input.searchUrl.trim()) {
        log.info('Using provided search URL directly');
        return input.searchUrl.trim();
    }
    // Naukri URL formats:
    // - Keyword only: https://www.naukri.com/{query}-jobs
    // - Keyword + location: https://www.naukri.com/{query}-jobs-in-{location}
    const query = (input.searchQuery || 'sales').toLowerCase().trim().replace(/\s+/g, '-');
    const locationRaw = (input.location || '').toLowerCase().trim();
    const location = locationRaw ? locationRaw.replace(/\s+/g, '-') : '';
    let baseUrl = location
        ? `https://www.naukri.com/${query}-jobs-in-${location}`
        : `https://www.naukri.com/${query}-jobs`;
    const params = new URLSearchParams();
    // Add experience filter
    if (input.experience && input.experience !== 'all') {
        params.append('experience', input.experience);
    }
    // Add job type filter
    if (input.jobType && input.jobType !== 'all') {
        params.append('jobType', input.jobType);
    }
    const queryString = params.toString();
    if (queryString) {
        baseUrl += `?${queryString}`;
    }
    return baseUrl;
}
/**
 * Extract job data from the page using Cheerio HTML parsing
 */
async function extractJobDataViaHTML(page) {
    log.info('Extracting job data via HTML parsing with Cheerio');
    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const jobs = [];
        const seenUrls = new Set();
        // Naukri-specific selectors for job cards
        // Primary selector: "tuple"/"jobTuple" blocks
        const jobElements = $([
            'article.jobTuple',
            'div.srp-tuple',
            'div.jobCard',
            'article[data-job-id]',
            'div[class*="tuple"]',
            'article[class*="tuple"]',
        ].join(','));
        log.info(`Found ${jobElements.length} job cards`);
        if (jobElements.length === 0) {
            // Fallback selectors
            const fallbackSelectors = [
                'article[class*="job"]',
                'div[class*="jobTuple"]',
                'div[class*="srp"]',
                'article.row'
            ];
            for (const selector of fallbackSelectors) {
                const elements = $(selector);
                if (elements.length > 0) {
                    log.info(`Fallback: Found ${elements.length} elements with selector: ${selector}`);
                    elements.each((_, element) => {
                        // If this is a container, try extracting tuples within it first
                        const container = $(element);
                        const tuples = container.find('article.jobTuple, div.srp-tuple, div.jobCard, article[data-job-id], div[class*="tuple"], article[class*="tuple"]');
                        if (tuples.length) {
                            tuples.each((_, tupleEl) => {
                                const job = extractJobFromElement($, $(tupleEl));
                                if (job && job.url && !seenUrls.has(job.url)) {
                                    seenUrls.add(job.url);
                                    jobs.push(job);
                                }
                            });
                        } else {
                            const job = extractJobFromElement($, container);
                            if (job && job.url && !seenUrls.has(job.url)) {
                                seenUrls.add(job.url);
                                jobs.push(job);
                            }
                        }
                    });
                    if (jobs.length > 0) break;
                }
            }
        } else {
            jobElements.each((_, element) => {
                const job = extractJobFromElement($, $(element));
                if (job && job.url && !seenUrls.has(job.url)) {
                    seenUrls.add(job.url);
                    jobs.push(job);
                }
            });
        }
        // If tuple-based parsing failed, fall back to job listing links and climb up to their containers
        if (jobs.length === 0) {
            const jobLinkEls = $('a[href*="job-listings"], a[href^="/job-listings"]').toArray();
            log.info(`Fallback: Found ${jobLinkEls.length} job listing links`);
            for (const el of jobLinkEls) {
                const $link = $(el);
                const href = $link.attr('href') || '';
                if (!href) continue;
                const absoluteUrl = href.startsWith('http') ? href : `https://www.naukri.com${href}`;
                if (seenUrls.has(absoluteUrl)) continue;
                const titleFromLink = ($link.text() || $link.attr('title') || '').trim();
                const container = $link.closest('article, div');
                const job = extractJobFromElement($, container.length ? container : $link.parent(), {
                    title: titleFromLink,
                    url: absoluteUrl,
                });
                if (job && job.url && !seenUrls.has(job.url)) {
                    seenUrls.add(job.url);
                    jobs.push(job);
                }
            }
        }
        log.info(`Extracted ${jobs.length} jobs via HTML parsing`);
        return jobs;
    } catch (error) {
        log.warning(`HTML parsing failed: ${error.message}`);
        return [];
    }
}
/**
 * Extract job data from a single job element using Naukri-specific selectors
 */
function extractJobFromElement($, $el, fallback = {}) {
    try {
        // Job Title - multiple possible selectors
        let title = '';
        const titleSelectors = [
            'a[href*="job-listings"]',
            'a[href^="/job-listings"]',
            'a.title, .title a',
            'a.subtitle, .subtitle a',
            'a[class*="title"]',
            'h2 a, h3 a',
            '.row1 a'
        ];
        for (const sel of titleSelectors) {
            const titleEl = $el.find(sel).first();
            if (titleEl.length && titleEl.text().trim()) {
                title = titleEl.text().trim();
                break;
            }
        }
        // Job URL
        let url = '';
        const urlSelectors = [
            'a[href*="job-listings"]',
            'a[href^="/job-listings"]',
            'a.title',
            'a.subtitle',
            'a[class*="title"]',
            'h2 a, h3 a',
            '.row1 a'
        ];
        for (const sel of urlSelectors) {
            const urlEl = $el.find(sel).first();
            if (urlEl.length && urlEl.attr('href')) {
                url = urlEl.attr('href');
                if (url && !url.startsWith('http')) {
                    url = `https://www.naukri.com${url}`;
                }
                break;
            }
        }
        // More resilient URL extraction: find job listing link within the tuple
        if (!url) {
            const anchors = $el.find('a[href]').toArray();
            for (const a of anchors) {
                const href = ($(a).attr('href') || '').trim();
                if (!href) continue;
                if (!href.includes('job-listings') && !href.startsWith('/job-listings')) continue;
                url = href.startsWith('http') ? href : `https://www.naukri.com${href}`;
                if (!title) {
                    title = ($(a).text() || $(a).attr('title') || '').trim();
                }
                break;
            }
        }
        if (!url) {
            const dataHref = ($el.attr('data-href') || $el.attr('data-url') || $el.attr('data-jdurl') || '').trim();
            if (dataHref) url = dataHref.startsWith('http') ? dataHref : `https://www.naukri.com${dataHref}`;
        }
        // Fallback to link-provided title/url when selectors fail
        if (!title && fallback.title) title = fallback.title;
        if (!url && fallback.url) url = fallback.url;
        // Company name
        let company = '';
        const companySelectors = [
            '.comp-name, .companyInfo',
            'a.comp-name',
            '.company-name',
            'a[class*="company"]',
            '.row2 a',
            'span[class*="comp"]',
            'a[href*="company"]',
        ];
        for (const sel of companySelectors) {
            const compEl = $el.find(sel).first();
            if (compEl.length && compEl.text().trim()) {
                company = compEl.text().trim();
                break;
            }
        }
        // Location
        let location = '';
        const locationSelectors = [
            '.loc-wrap .location, .location',
            '.locWdth',
            'span[class*="location"]',
            '.row3 .location',
            '[class*="loc"]',
        ];
        for (const sel of locationSelectors) {
            const locEl = $el.find(sel).first();
            if (locEl.length && locEl.text().trim()) {
                location = locEl.text().trim();
                break;
            }
        }
        // Experience
        let experience = 'Not specified';
        const expSelectors = [
            '.exp-wrap .exp, .experience',
            'span[class*="exp"]',
            '.row4 .exp'
        ];
        for (const sel of expSelectors) {
            const expEl = $el.find(sel).first();
            if (expEl.length && expEl.text().trim()) {
                experience = expEl.text().trim();
                break;
            }
        }
        // Salary
        let salary = 'Not specified';
        const salarySelectors = [
            '.sal-wrap .salary, .salary',
            'span[class*="sal"]',
            '.row5 .salary'
        ];
        for (const sel of salarySelectors) {
            const salEl = $el.find(sel).first();
            if (salEl.length && salEl.text().trim()) {
                salary = salEl.text().trim();
                break;
            }
        }
        // Job snippet/description
        const descEl = $el.find('.job-desc, .desc, .job-description, .snippet').clone();
        descEl.find('.similar-jobs, .related-jobs').remove();
        const snippet = descEl.text().trim() || '';
        const snippetHtml = descEl.html()?.trim() || '';
        // Posted date
        let postedDate = '';
        const dateSelectors = [
            '.job-post-day, .date',
            'span[class*="date"]',
            'span[class*="posted"]',
            '.postedDate'
        ];
        for (const sel of dateSelectors) {
            const dateEl = $el.find(sel).first();
            if (dateEl.length && dateEl.text().trim()) {
                postedDate = dateEl.text().trim();
                break;
            }
        }
        // Only add if we have at least title or URL
        if (title || url) {
            return {
                title: title || 'Unknown Title',
                company,
                location,
                salary,
                experience,
                jobType: 'Not specified',
                postedDate,
                descriptionHtml: snippetHtml,
                descriptionText: snippet,
                url,
                scrapedAt: new Date().toISOString()
            };
        }
        return null;
    } catch (err) {
        log.debug(`Error extracting individual job: ${err.message}`);
        return null;
    }
}
/**
 * Debug: Save page HTML snippet for analysis when 0 jobs found
 */
async function saveDebugInfo(page) {
    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        // Get body content sample
        const bodySnippet = $('body').html()?.substring(0, 5000) || '';
        // Log some key elements for debugging
        const articleCount = $('article').length;
        const divJobCount = $('[class*="job"]').length;
        const tupleCount = $('[class*="tuple"]').length;
        log.warning('DEBUG: Page structure analysis', {
            articleCount,
            divJobCount,
            tupleCount,
            title: $('title').text(),
            hasChallenge: html.includes('Just a moment') || html.includes('cf-browser') || html.includes('Security check')
        });
        // Save full HTML to key-value store for later analysis
        await Actor.setValue('DEBUG_PAGE_HTML', html, { contentType: 'text/html' });
        log.info('Saved full page HTML to DEBUG_PAGE_HTML for analysis');
    } catch (error) {
        log.warning(`Failed to save debug info: ${error.message}`);
    }
}
/**
 * Main Actor execution
 */
try {
    // Get Actor input
    const input = await Actor.getInput() || {};
    const fullPageDetails = input.fullPageDetails ?? true; // Default to true for complete data
    log.info('Starting Naukri Jobs Scraper', {
        searchUrl: input.searchUrl,
        searchQuery: input.searchQuery,
        location: input.location,
        maxJobs: input.maxJobs,
        fullPageDetails
    });
    // Validate input - either searchUrl OR searchQuery must be provided
    if (!input.searchUrl?.trim()) {
        if (!input.searchQuery?.trim()) {
            throw new Error('Invalid input: Either provide a "searchUrl" OR provide a "searchQuery"');
        }
    }
    // Validate maxJobs range
    const maxJobs = input.maxJobs ?? 20; // Default to 20 for QA compliance
    if (maxJobs < 0 || maxJobs > 10000) {
        throw new Error('maxJobs must be between 0 and 10000');
    }
    // Build search URL
    const searchUrl = buildSearchUrl(input);
    log.info(`Search URL: ${searchUrl}`);
    // Create proxy configuration
    const proxyConfiguration = await Actor.createProxyConfiguration(
        input.proxyConfiguration || { useApifyProxy: true }
    );
    // Statistics tracking
    let totalJobsScraped = 0;
    let pagesProcessed = 0;
    let extractionMethod = 'None';
    const startTime = Date.now();
    // Deduplication - track seen job URLs
    const seenJobUrls = new Set();
    // Get proxy URL for Camoufox
    const proxyUrl = await proxyConfiguration.newUrl();
    // Create Playwright crawler with Camoufox for anti-bot bypass
    const maxRequestsPerCrawl = Math.min(
        200,
        maxJobs === 0 ? 200 : Math.ceil(maxJobs / 20) + 5
    );
    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl,
        maxConcurrency: 3,
        navigationTimeoutSecs: 60, // First page needs more time due to Camoufox startup
        requestHandlerTimeoutSecs: 300, // 5 minutes for full enrichment of batch
        retryOnBlocked: true,
        launchContext: {
            launcher: firefox,
            launchOptions: await camoufoxLaunchOptions({
                headless: true,
                proxy: proxyUrl,
                geoip: true,
                os: 'windows',
                locale: 'en-IN',
            }),
        },
        async requestHandler({ page, request }) {
            pagesProcessed++;
            log.info(`Processing page ${pagesProcessed}: ${request.url}`);
            try {
                // Set realistic headers for India
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                });
                // Navigate to page with retry to handle aborts
                await navigateWithRetry(page, request.url);
                // Wait for initial load - reduced timeout for speed
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
                // Check for challenge pages and handle them
                let challengeDetected = false;
                let retryCount = 0;
                const maxRetries = 3;
                while (retryCount < maxRetries) {
                    const title = await page.title();
                    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
                    if (title.includes('Just a moment') ||
                        title.includes('Cloudflare') ||
                        title.includes('Security check') ||
                        bodyText.includes('unusual traffic') ||
                        bodyText.includes('Checking your browser')) {
                        challengeDetected = true;
                        log.warning(`Challenge detected (attempt ${retryCount + 1}/${maxRetries})`);
                        // Wait for challenge to resolve
                        await page.waitForTimeout(3000);
                        // Try to click Turnstile checkbox if present
                        try {
                            // Look for Turnstile iframe
                            const turnstileFrame = page.frameLocator('iframe[src*="challenges"]');
                            const checkbox = turnstileFrame.locator('input[type="checkbox"]');
                            if (await checkbox.count() > 0) {
                                log.info('Found challenge checkbox, attempting click...');
                                await checkbox.first().click({ timeout: 5000 });
                                await page.waitForTimeout(3000);
                            }
                        } catch (clickErr) {
                            log.debug('No clickable challenge element found');
                        }
                        // Wait for page to potentially resolve
                        await page.waitForTimeout(5000);
                        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
                        retryCount++;
                    } else {
                        // No challenge detected, break out
                        if (challengeDetected) {
                            log.info('Challenge bypassed successfully!');
                        }
                        break;
                    }
                }
                if (retryCount >= maxRetries) {
                    log.error('Failed to bypass challenge after maximum retries');
                    await saveDebugInfo(page);
                    return;
                }
                // Add a small delay to ensure dynamic content loads - wait for job listings
                await waitForSearchResultsToRender(page);
                let jobs = [];
                let pageExtractionMethod = '';
                let searchParams = {}; // Declare outside try block for pagination access
                // Extract search parameters from current URL
                const currentUrl = page.url();
                let searchQuery = '';
                let searchLocation = '';
                // Prefer explicit input values when present
                const parsedUrl = new URL(currentUrl);
                // Extract page number from URL (supports both `?pageNo=` and `-2` style)
                const urlParams = parsedUrl.searchParams;
                let currentPageNo = parseInt(urlParams.get('pageNo') || '1', 10);
                if (!Number.isFinite(currentPageNo) || currentPageNo < 1) currentPageNo = 1;
                if (!urlParams.get('pageNo')) {
                    const pathPageMatch = parsedUrl.pathname.replace(/\/$/, '').match(/-(\d+)$/);
                    if (pathPageMatch) {
                        const n = parseInt(pathPageMatch[1], 10);
                        if (Number.isFinite(n) && n >= 1) currentPageNo = n;
                    }
                }
                const pathMatch = parsedUrl.pathname.match(/\/([^/]+?)-jobs(?:-in-([^/?]+))?/i);
                if (pathMatch) {
                    searchQuery = pathMatch[1]?.replace(/-/g, ' ') || searchQuery;
                    // Remove pagination suffix from location, e.g. "mumbai-2"
                    const locSlug = pathMatch[2]?.replace(/-(\d+)$/, '') || '';
                    searchLocation = locSlug ? locSlug.replace(/-/g, ' ') : searchLocation;
                }
                // Normalize inputs for API
                searchQuery = (searchQuery || input.searchQuery || '').trim();
                searchLocation = (searchLocation || input.location || '').trim();
                log.info(`Search query: "${searchQuery}", Location: "${searchLocation}", Page: ${currentPageNo}`);
                // Strategy 1: HTML parsing (fast and most reliable without IN residential proxy)
                jobs = await extractJobDataViaHTML(page);
                if (jobs.length > 0) {
                    pageExtractionMethod = 'HTML Parsing (Cheerio)';
                    extractionMethod = pageExtractionMethod;
                    log.info(`✓ HTML parsing successful: ${jobs.length} jobs`);
                }
                // Strategy 2: JSON-LD fallback (sometimes present)
                if (jobs.length === 0) {
                    jobs = await extractJobsViaJsonLD(page);
                    if (jobs.length > 0) {
                        pageExtractionMethod = 'JSON-LD';
                        extractionMethod = pageExtractionMethod;
                        log.info(`✓ JSON-LD extraction successful: ${jobs.length} jobs`);
                    }
                }
                // If still no jobs, save debug info
                if (jobs.length === 0) {
                    log.warning('No jobs found with any extraction method. Saving debug info...');
                    await saveDebugInfo(page);
                }
                if (jobs.length > 0) {
                    // Filter jobs if we've reached the limit
                    let jobsToSave = maxJobs > 0
                        ? jobs.slice(0, Math.max(0, maxJobs - totalJobsScraped))
                        : jobs;
                    // Remove duplicates - filter out jobs we've already seen
                    const uniqueJobs = jobsToSave.filter(job => {
                        if (!job.url) return true; // Keep jobs without URL
                        if (seenJobUrls.has(job.url)) {
                            log.debug(`Skipping duplicate job: ${job.title} (${job.url})`);
                            return false;
                        }
                        seenJobUrls.add(job.url);
                        return true;
                    });
                    if (uniqueJobs.length < jobsToSave.length) {
                        log.info(`Removed ${jobsToSave.length - uniqueJobs.length} duplicate jobs`);
                    }
                    jobsToSave = uniqueJobs;
                    // Always enrich from detail pages to get full descriptions (if enabled)
                    if (jobsToSave.length > 0 && fullPageDetails) {
                        log.info('Enriching jobs with full descriptions from detail pages...');
                        jobsToSave = await enrichJobsWithFullDescriptions(jobsToSave, page, fullPageDetails);
                    }
                    // Save jobs to dataset
                    if (jobsToSave.length > 0) {
                        await Actor.pushData(jobsToSave);
                        totalJobsScraped += jobsToSave.length;
                        log.info(`Saved ${jobsToSave.length} jobs. Total: ${totalJobsScraped}`);
                    }
                    // Check if we've reached the limit
                    if (maxJobs > 0 && totalJobsScraped >= maxJobs) {
                        log.info(`Reached maximum jobs limit: ${maxJobs}`);
                        return;
                    }
                    // Pagination: deterministic `pageNo` param to avoid fragile DOM selectors.
                    // Prefer the real "Next" link; fallback to path-based `-2` URLs.
                    // Stops automatically if no new jobs are saved or if maxJobs is reached.
                    if (maxJobs === 0 || totalJobsScraped < maxJobs) {
                        const maxPages = maxJobs === 0 ? 50 : Math.ceil(maxJobs / 20);
                        const nextPageNo = currentPageNo + 1;
                        if (nextPageNo <= maxPages && jobsToSave.length > 0) {
                            // 1) Try "Next" button href
                            const nextHref = await page.evaluate(() => {
                                const candidates = Array.from(document.querySelectorAll('a.styles_btn-secondary__2AsIP'));
                                const next = candidates.find(a => (a.textContent || '').trim().toLowerCase() === 'next');
                                const href = next?.getAttribute('href') || '';
                                if (!href) return '';
                                try {
                                    return href.startsWith('http') ? href : new URL(href, location.origin).toString();
                                } catch {
                                    return '';
                                }
                            });
                            let nextPageUrl = '';
                            if (nextHref) {
                                nextPageUrl = nextHref;
                            }
                            // 2) Fallback: build `-2` style URL from current path
                            if (!nextPageUrl) {
                                const u = new URL(request.url);
                                u.searchParams.delete('pageNo');
                                const basePath = u.pathname.replace(/\/$/, '').replace(/-(\d+)$/, '');
                                u.pathname = `${basePath}-${nextPageNo}`;
                                nextPageUrl = u.toString();
                            }
                            await crawler.addRequests([{
                                url: nextPageUrl,
                                uniqueKey: `${nextPageUrl}-page-${nextPageNo}`,
                            }]);
                            log.info(`Queued next page: ${nextPageUrl}`);
                        } else if (jobsToSave.length === 0) {
                            log.info('No new jobs saved on this page; stopping pagination');
                        } else {
                            log.info('Reached pagination limit for this run');
                        }
                    }
                } else {
                    log.warning('No jobs found on this page');
                }
            } catch (error) {
                log.error(`Error processing page: ${error.message}`, {
                    url: request.url
                });
            }
        },
        async failedRequestHandler({ request }, error) {
            log.error(`Request failed: ${request.url} - ${error.message}`);
        }
    });
    // Start crawling
    log.info('Starting crawler with Camoufox for anti-bot bypass...');
    await crawler.run([searchUrl]);
    // Calculate statistics
    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 1000);
    const statistics = {
        totalJobsScraped,
        pagesProcessed,
        extractionMethod,
        duration: `${duration} seconds`,
        timestamp: new Date().toISOString()
    };
    // Save statistics
    await Actor.setValue('statistics', statistics);
    log.info('✓ Scraping completed successfully!', statistics);
    if (totalJobsScraped > 0) {
        log.info(`Successfully scraped ${totalJobsScraped} jobs in ${duration} seconds`);
    } else {
        log.warning('No jobs were scraped. Please check your search parameters.');
    }
} catch (error) {
    log.exception(error, 'Actor failed with error');
    throw error;
}
// Exit successfully
await Actor.exit();


import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';

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

/**
 * Fetch complete job description using Playwright context requests (Camoufox session)
 * Avoids Akamai blocks seen with plain HTTP clients by reusing the stealth browser session
 */
async function fetchFullDescription(jobUrl, page, userAgent = '', cookieString = '') {
    try {
        const context = page.context();
        const ua = userAgent || await page.evaluate(() => navigator.userAgent);
        const cookies = cookieString || (await context.cookies()).map(c => `${c.name}=${c.value}`).join('; ');

        const requestHeaders = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
            'Cookie': cookies,
            'User-Agent': ua,
            'Referer': 'https://www.naukri.com/',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
        };

        // Fast path: use got-scraping (HTTP client) for speed; fallback to Playwright session on blocks.
        let body = '';
        try {
            const resp = await gotScraping({
                url: jobUrl,
                headers: requestHeaders,
                http2: true,
                timeout: { request: 15000 },
                retry: { limit: 1 },
            });

            if (resp.statusCode === 403 || resp.statusCode === 503 || resp.statusCode === 429) {
                throw new Error(`blocked_http_${resp.statusCode}`);
            }

            if (resp.statusCode !== 200) {
                log.debug(`Detail page returned status ${resp.statusCode}: ${jobUrl}`);
                return null;
            }

            body = resp.body || '';
        } catch (httpErr) {
            // Fallback: Use the Playwright context request (shares Camoufox session)
            const response = await context.request.get(jobUrl, {
                headers: requestHeaders,
                timeout: 20000,
            });

            const status = response.status();
            if (status === 403 || status === 503 || status === 429) {
                log.debug(`Block detected on detail page (${status}): ${jobUrl}`);
                return { blocked: true };
            }

            if (status !== 200) {
                log.debug(`Detail page returned status ${status}: ${jobUrl}`);
                return null;
            }

            body = await response.text();
        }

        const $ = cheerio.load(body);

        // Check if we got a challenge page
        const title = $('title').text();
        if (title.includes('Just a moment') || title.includes('Cloudflare') || title.includes('Security check')) {
            log.debug(`Challenge page detected: ${jobUrl}`);
            return { blocked: true };
        }

        // Remove source/apply buttons and unwanted elements
        $('p.source, [data-source], .source, .apply-button, .actions, .notclicky').remove();

        // Prefer JSON-LD JobPosting description if present (usually the most complete)
        const jsonLdScripts = $('script[type="application/ld+json"]').map((_, el) => $(el).text()).get();
        for (const script of jsonLdScripts) {
            try {
                const data = JSON.parse(script);
                const candidates = [];
                if (Array.isArray(data)) candidates.push(...data);
                else candidates.push(data);

                for (const candidate of candidates) {
                    if (!candidate) continue;
                    if (candidate['@type'] === 'JobPosting' && candidate.description) {
                        const descriptionHtml = String(candidate.description);
                        const descriptionText = stripHtml(descriptionHtml);
                        return { descriptionHtml, descriptionText };
                    }
                    if (candidate['@graph'] && Array.isArray(candidate['@graph'])) {
                        for (const g of candidate['@graph']) {
                            if (g && g['@type'] === 'JobPosting' && g.description) {
                                const descriptionHtml = String(g.description);
                                const descriptionText = stripHtml(descriptionHtml);
                                return { descriptionHtml, descriptionText };
                            }
                        }
                    }
                }
            } catch {
                // ignore parse errors
            }
        }

        // Try multiple selectors for job description on detail page - Naukri-specific
        const descriptionSelectors = [
            'div.styles_JDC__dang-inner-html__h0K4t',
            'div.styles_detail__U2rw4.styles_dang-inner-html___BCwh',
            '.styles_JDC__dang-inner-html__h0K4t',
            '.styles_dang-inner-html___BCwh',
            'div[class*="JDC__dang-inner-html"]',
            'div[class*="dang-inner-html"]',
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

        let descriptionHtml = '';
        let descriptionText = '';

        for (const selector of descriptionSelectors) {
            const descEl = $(selector).clone();
            if (descEl.length && descEl.text().trim().length > 100) {
                // Remove source elements before extraction
                descEl.find('p.source, [data-source], .source').remove();

                // Remove "Related Jobs" section - find and remove everything after headings containing "related"
                descEl.find('h2, h3, h4').each((_, heading) => {
                    const $heading = $(heading);
                    const headingText = $heading.text().toLowerCase();
                    if (headingText.includes('related') || headingText.includes('similar') || headingText.includes('recommended')) {
                        // Remove this heading and all siblings after it
                        $heading.nextAll().remove();
                        $heading.remove();
                    }
                });

                descriptionHtml = descEl.html()?.trim() || '';
                descriptionText = descEl.text().trim();
                break;
            }
        }

        // If no description found with specific selectors, try the main content area
        if (!descriptionText) {
            const mainContent = $('main, article, .main-content, #main, .content, .jobPage');
            if (mainContent.length) {
                // Remove navigation, header, footer, source elements
                mainContent.find('nav, header, footer, .sidebar, .related-jobs, .similar-jobs, p.source, [data-source]').remove();
                descriptionHtml = mainContent.html()?.trim() || '';
                descriptionText = mainContent.text().trim();
            }
        }

        // Try company/about blocks if still empty
        if (!descriptionText) {
            const aboutSelectors = [
                'div.styles_detail__U2rw4.styles_dang-inner-html___BCwh',
                '.styles_detail__U2rw4.styles_dang-inner-html___BCwh',
                '.styles_dang-inner-html___BCwh',
                'div[class*="styles_detail__"][class*="dang-inner-html"]',
                '.about-company',
                '.company-info',
            ];
            for (const selector of aboutSelectors) {
                const aboutEl = $(selector).clone();
                if (aboutEl.length && aboutEl.text().trim().length > 50) {
                    descriptionHtml = aboutEl.html()?.trim() || '';
                    descriptionText = aboutEl.text().trim();
                    break;
                }
            }
        }

        // As a last resort, use the full body text if something went wrong with selectors.
        if (!descriptionText) {
            const bodyText = $('body').text().trim();
            if (bodyText.length > 0) {
                descriptionText = bodyText;
                descriptionHtml = $('body').html()?.trim() || '';
            }
        }

        // Clean description - remove source paragraph pattern
        descriptionHtml = descriptionHtml.replace(/<p[^>]*class="source"[^>]*>.*?<\/p>/gi, '');
        descriptionHtml = descriptionHtml.replace(/<p[^>]*data-source[^>]*>.*?<\/p>/gi, '');

        // Also try to extract additional job details from detail page - Naukri-specific
        const experience = $('.exp-wrap .exp, .experience span, [class*="experience"]').first().text().trim() || '';
        const salary = $('.salary-wrap .salary, .salary span, [class*="salary"]').first().text().trim() || '';
        const jobType = $('.job-type, .employment-type, [class*="job-type"]').first().text().trim() || '';

        if (descriptionText && descriptionText.length > 0) {
            return {
                descriptionHtml,
                descriptionText,
                experience: experience || null,
                salary: salary || null,
                jobType: jobType || null,
            };
        }

        return null;
    } catch (error) {
        // Check if error is related to blocking
        if (error.message && (error.message.includes('403') || error.message.includes('503'))) {
            log.debug(`Block detected (error): ${jobUrl}`);
            return { blocked: true };
        }
        log.debug(`Failed to fetch detail page ${jobUrl}: ${error.message}`);
        return null;
    }
}

/**
 * Enrich jobs with full descriptions from detail pages
 * Uses session cookies from Camoufox to maintain Cloudflare bypass
 */
async function enrichJobsWithFullDescriptions(jobs, page, maxConcurrency = 20) {
    if (jobs.length === 0) return jobs;

    log.info(`Fetching full descriptions for ${jobs.length} jobs...`);

    // Get cookies and user agent from current Camoufox session
    const cookies = await page.context().cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const userAgent = await page.evaluate(() => navigator.userAgent);

    log.debug(`Using ${cookies.length} cookies from Camoufox session for detail pages`);

    // Process jobs in batches to avoid overwhelming the server
    const enrichedJobs = [];
    const batchSize = maxConcurrency;
    let blockedCount = 0;

    for (let i = 0; i < jobs.length; i += batchSize) {
        const batch = jobs.slice(i, i + batchSize);

        const batchPromises = batch.map(async (job) => {
            if (!job.url) return job;

            const fullDesc = await fetchFullDescription(job.url, page, userAgent, cookieString);

            // Check if we got blocked
            if (fullDesc && fullDesc.blocked) {
                blockedCount++;
                log.warning(`Detail page blocked: ${job.url}`);
                // Return job with original snippet - don't fail the entire batch
                return job;
            }

            if (fullDesc && (fullDesc.descriptionText || fullDesc.descriptionHtml)) {
                return {
                    ...job,
                    descriptionHtml: fullDesc.descriptionHtml || job.descriptionHtml,
                    descriptionText: fullDesc.descriptionText || job.descriptionText,
                    experience: fullDesc.experience || job.experience,
                    salary: fullDesc.salary || job.salary,
                    jobType: fullDesc.jobType || job.jobType,
                };
            }

            return job;
        });

        const batchResults = await Promise.all(batchPromises);
        enrichedJobs.push(...batchResults);

        log.info(`Enriched ${Math.min(i + batchSize, jobs.length)}/${jobs.length} jobs with full descriptions`);

        // Small delay between batches - keep minimal to reduce throttling risk
        if (i + batchSize < jobs.length) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    if (blockedCount > 0) {
        log.warning(`${blockedCount} detail pages were blocked - using snippets instead`);
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
            '.row2 a'
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
            '.row3 .location'
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

    log.info('Starting Naukri Jobs Scraper', {
        searchUrl: input.searchUrl,
        searchQuery: input.searchQuery,
        location: input.location,
        maxJobs: input.maxJobs
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
        maxConcurrency: 3, // Increased for faster scraping
        navigationTimeoutSecs: 30, // Reduced for speed
        requestHandlerTimeoutSecs: 120, // Reduced but enough for enrichment
        launchContext: {
            launcher: firefox,
            launchOptions: await camoufoxLaunchOptions({
                // Headless mode - must be boolean for Crawlee/Playwright
                headless: true,

                // Proxy configuration - use residential proxy for trusted IP
                proxy: proxyUrl,

                // GeoIP spoofing - matches location/timezone/locale to proxy IP
                // This is critical for anti-bot bypass
                geoip: true,

                // OS fingerprint - Windows is most common and least suspicious
                os: 'windows',

                // Locale and language settings - match India for Naukri
                locale: 'en-IN',

                // Screen constraints for realistic viewport
                // Avoid fixed sizes as they can be fingerprinted
                screen: {
                    minWidth: 1024,
                    maxWidth: 1920,
                    minHeight: 768,
                    maxHeight: 1080,
                },
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
                await page.waitForTimeout(2000);

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

                    // Always enrich from detail pages to get full descriptions
                    if (jobsToSave.length > 0) {
                        log.info('Enriching jobs with full descriptions from detail pages...');
                        jobsToSave = await enrichJobsWithFullDescriptions(jobsToSave, page);
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

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

// Initialize Actor at the start
await Actor.init();

// Global error handlers
process.on('unhandledRejection', async (reason) => {
    try {
        console.error('UnhandledRejection:', reason);
        await Actor.setValue('UNHANDLED_REJECTION', typeof reason === 'string' ? reason : JSON.stringify(reason));
    } catch (e) {
        console.error('Failed to store UNHANDLED_REJECTION:', e);
    }
    await gracefulExit(1);
});

process.on('uncaughtException', async (err) => {
    try {
        console.error('UncaughtException:', err?.stack || err);
        await Actor.setValue('UNCAUGHT_EXCEPTION', err?.stack || String(err));
    } catch (e) {
        console.error('Failed to store UNCAUGHT_EXCEPTION:', e);
    }
    await gracefulExit(1);
});

// Graceful exit helper
async function gracefulExit(exitCode = 0) {
    try {
        await Actor.exit({ exitCode });
    } catch (e) {
        console.error('Actor.exit failed:', e);
        process.exit(exitCode);
    }
}

// Main execution wrapper
async function main() {
    try {
        const input = await Actor.getInput();

        const {
            pincode = '411001',
            searchUrls = [],
            searchQueries = [],
            maxProductsPerSearch = 100,
            proxyConfiguration = { useApifyProxy: false },
            maxRequestRetries = 3,
            navigationTimeout = 60000, // Reduced from 90s
            headless = true, // Changed default to true for performance
            screenshotOnError = true,
            debugMode = false, // Changed default to false
            scrollCount = 3 // Reduced from 5
        } = input;

        // Optimized User-Agent list
        const USER_AGENTS = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
        ];

        function pickRandom(arr) {
            return arr[Math.floor(Math.random() * arr.length)];
        }

        function parseProxyUrl(proxyUrl) {
            try {
                const u = new URL(proxyUrl);
                const server = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
                const proxy = { server };
                if (u.username) proxy.username = decodeURIComponent(u.username);
                if (u.password) proxy.password = decodeURIComponent(u.password);
                return proxy;
            } catch (e) {
                return null;
            }
        }

        // Generate search URLs
        const allSearchUrls = [
            ...searchUrls,
            ...searchQueries.map(query => `https://www.zepto.com/search?query=${encodeURIComponent(query)}`)
        ];

        const proxyConfig = proxyConfiguration.useApifyProxy 
            ? await Actor.createProxyConfiguration(proxyConfiguration)
            : undefined;

        const customProxyUrl = proxyConfiguration?.customProxyUrl || proxyConfiguration?.proxyUrl || proxyConfiguration?.proxy;
        const launchProxy = customProxyUrl ? parseProxyUrl(customProxyUrl) : null;

        // Optimized pincode location setter
        async function setPincodeLocation(page, log, pincode) {
            try {
                log.info(`🎯 Setting location to pincode: ${pincode}`);
                
                await page.waitForLoadState('domcontentloaded');
                await page.waitForTimeout(1500); // Reduced
                
                const locationSelectors = [
                    'button[aria-label="Select Location"]',
                    'button.__4y7HY',
                    'div.a0Ppr button'
                ];
                
                let clicked = false;
                for (const selector of locationSelectors) {
                    try {
                        const button = page.locator(selector).first();
                        if (await button.count() > 0) {
                            await button.click({ timeout: 3000 });
                            log.info(`✓ Clicked location button: ${selector}`);
                            clicked = true;
                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }
                
                if (!clicked) {
                    log.warning('⚠️ Location button not found');
                    return false;
                }
                
                await page.waitForTimeout(1000); // Reduced
                
                const modalSelector = 'div[data-testid="address-modal"]';
                try {
                    await page.waitForSelector(modalSelector, { timeout: 5000 });
                } catch (e) {
                    log.warning('⚠️ Location modal not detected');
                    return false;
                }
                
                await page.waitForTimeout(800); // Reduced
                
                const searchInput = page.locator('div[data-testid="address-search-input"] input[type="text"]').first();
                
                if (await searchInput.count() === 0) {
                    log.error('❌ Search input not found in modal');
                    return false;
                }
                
                await searchInput.focus();
                await page.waitForTimeout(200);
                await page.keyboard.press('Control+A');
                await page.keyboard.press('Backspace');
                await page.waitForTimeout(200);
                await searchInput.type(pincode, { delay: 80 }); // Reduced delay
                
                await page.waitForTimeout(1500); // Reduced
                
                try {
                    await page.waitForSelector('div[data-testid="address-search-item"]', { timeout: 5000 });
                } catch (e) {
                    log.error('❌ No address results appeared');
                    return false;
                }
                
                const firstAddress = page.locator('div[data-testid="address-search-item"]').first();
                const count = await firstAddress.count();
                
                if (count > 0) {
                    await firstAddress.click({ force: true });
                    await page.waitForTimeout(1500); // Reduced
                    
                    const modalStillOpen = await page.locator(modalSelector).count();
                    if (modalStillOpen === 0) {
                        log.info('✅ Location set successfully');
                        return true;
                    }
                }
                
                return false;
            } catch (error) {
                log.error(`❌ Error setting pincode: ${error.message}`);
                return false;
            }
        }

        // Optimized auto-scroll
        async function autoScroll(page, log, scrollCount = 3) {
            try {
                for (let i = 0; i < scrollCount; i++) {
                    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                    await page.waitForTimeout(1000); // Reduced
                }
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.waitForTimeout(300); // Reduced
            } catch (error) {
                log.warning(`Auto-scroll failed: ${error.message}`);
            }
        }

        // Optimized debug function
        async function debugPageState(page, log, label = 'debug') {
            if (!debugMode) return;
            
            try {
                const screenshot = await page.screenshot({ fullPage: false }); // Only viewport
                await Actor.setValue(`${label}-${Date.now()}.png`, screenshot, { contentType: 'image/png' });
                
                const pageInfo = await page.evaluate(() => ({
                    url: window.location.href,
                    title: document.title,
                    productCount: document.querySelectorAll('a.B4vNQ').length
                }));
                
                log.info(`Page state: ${JSON.stringify(pageInfo)}`);
            } catch (error) {
                log.error(`Debug failed: ${error.message}`);
            }
        }

        // Optimized wait for results
        async function waitForSearchResults(page, log) {
            const mainSelector = 'a.B4vNQ';
            
            try {
                await page.waitForSelector(mainSelector, { timeout: 10000 });
                const count = await page.locator(mainSelector).count();
                if (count > 0) {
                    await page.waitForTimeout(500); // Reduced
                    return true;
                }
            } catch (e) {
                // Fallback check
                try {
                    const bodyText = await page.evaluate(() => document.body.innerText || '');
                    if (bodyText.includes('₹') || /\bADD\b/i.test(bodyText)) {
                        return true;
                    }
                } catch (err) {
                    // Ignore
                }
            }
            
            log.warning('No search results found');
            return false;
        }

        // Optimized product extraction
        async function extractZeptoProducts(page, log) {
            try {
                const products = await page.evaluate(() => {
                    const productCards = [];
                    const productLinks = document.querySelectorAll('a.B4vNQ');

                    function textOrNull(el) {
                        return el ? (el.textContent || '').trim() : null;
                    }

                    productLinks.forEach((link, index) => {
                        try {
                            const productUrl = link.href;
                            const urlMatch = productUrl.match(/\/pn\/([^/]+)\/pvid\/([^/]+)/) || 
                                           productUrl.match(/\/(?:p|product)\/([^/]+)\/([^/]+)/);
                            const productSlug = urlMatch?.[1] || null;
                            const productId = urlMatch?.[2] || `zepto-${index}`;

                            const card = link.querySelector('div.cavQgJ.cTH4Df') || link;

                            // Name extraction
                            const nameSelectors = [
                                'div[data-slot-id="ProductName"] span',
                                'div.cQAjo6.ch5GgP span',
                                'h3', 'h2'
                            ];
                            let productName = null;
                            for (const sel of nameSelectors) {
                                const el = card.querySelector(sel);
                                if (el && textOrNull(el)) {
                                    productName = textOrNull(el);
                                    break;
                                }
                            }
                            if (!productName) {
                                productName = link.getAttribute('title') || 
                                            link.querySelector('img')?.alt || null;
                            }

                            // Image
                            const imgEl = card.querySelector('img') || link.querySelector('img');
                            const productImage = imgEl?.src || imgEl?.getAttribute('data-src') || null;

                            // Price
                            let currentPrice = null;
                            const spans = Array.from(card.querySelectorAll('span'));
                            for (const s of spans) {
                                const match = (s.textContent || '').match(/₹\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
                                if (match) {
                                    currentPrice = parseFloat(match[1].replace(/,/g, ''));
                                    break;
                                }
                            }

                            // Original price
                            let originalPrice = null;
                            const origSpan = spans.find(s => 
                                /(MRP|strike|original)/i.test(s.className || ''));
                            if (origSpan) {
                                const match = (origSpan.textContent || '').match(/₹\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
                                if (match) originalPrice = parseFloat(match[1].replace(/,/g, ''));
                            }

                            // Discount
                            let discountPercentage = null;
                            if (currentPrice && originalPrice && originalPrice > currentPrice) {
                                discountPercentage = Math.round(((originalPrice - currentPrice) / originalPrice) * 100);
                            }

                            // Pack size
                            const packSizeEl = card.querySelector('[data-slot-id="PackSize"] span');
                            const productWeight = packSizeEl ? textOrNull(packSizeEl) : null;

                            // Rating
                            let rating = null;
                            const ratingEl = card.querySelector('[data-slot-id="RatingInformation"]');
                            if (ratingEl) {
                                const match = (ratingEl.textContent || '').match(/(\d+\.\d+)/);
                                if (match) rating = parseFloat(match[1]);
                            }

                            const isSponsored = !!card.querySelector('[data-slot-id="SponsorTag"]');
                            const isOutOfStock = card.getAttribute?.('data-is-out-of-stock') === 'true';

                            if (productName || currentPrice || productImage) {
                                productCards.push({
                                    productId,
                                    productSlug,
                                    productName,
                                    productImage,
                                    currentPrice,
                                    originalPrice,
                                    discountPercentage,
                                    productWeight,
                                    rating,
                                    isSponsored,
                                    isOutOfStock,
                                    productUrl,
                                    scrapedAt: new Date().toISOString()
                                });
                            }
                        } catch (err) {
                            console.error(`Error processing product ${index}:`, err);
                        }
                    });

                    return productCards;
                });
                
                log.info(`✅ Extracted ${products.length} products`);
                return products;
            } catch (error) {
                log.error(`Error extracting products: ${error.message}`);
                return [];
            }
        }

        // Initialize crawler
        const crawler = new PlaywrightCrawler({
            proxyConfiguration: proxyConfig,
            maxRequestRetries,
            navigationTimeoutSecs: navigationTimeout / 1000,
            headless,
            maxConcurrency: 1, // Process one at a time for location setting
            
            launchContext: {
                launchOptions: {
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--disable-dev-shm-usage',
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-gpu',
                        '--disable-software-rasterizer'
                    ],
                    ...((!proxyConfig && launchProxy) ? { proxy: launchProxy } : {})
                }
            },

            preNavigationHooks: [
                async ({ page, log }) => {
                    try {
                        const ua = pickRandom(USER_AGENTS);

                        await page.setExtraHTTPHeaders({
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                            'User-Agent': ua
                        });

                        await page.setViewportSize({ width: 1920, height: 1080 });

                        await page.addInitScript((ua) => {
                            Object.defineProperty(navigator, 'webdriver', { get: () => false });
                            Object.defineProperty(navigator, 'userAgent', { get: () => ua });
                        }, ua).catch(() => {});
                    } catch (e) {
                        log.error(`preNavigationHook error: ${e.message}`);
                    }
                }
            ],

            async requestHandler({ page, request, log }) {
                const { url } = request;
                const isFirstRequest = request.userData?.isFirst || false;

                log.info(`🔍 Processing: ${url}`);

                try {
                    if (isFirstRequest && !locationSetGlobally) {
                        const locationSet = await setPincodeLocation(page, log, pincode);
                        locationSetGlobally = locationSet;
                        await page.waitForTimeout(1500);
                    }
                    
                    await page.waitForLoadState('domcontentloaded');
                    await page.waitForTimeout(2000); // Reduced
                    
                    // Close popups
                    try {
                        const closeButton = page.locator('button[aria-label*="Close"]').first();
                        if (await closeButton.count() > 0) {
                            await closeButton.click({ timeout: 1500 });
                        }
                    } catch (e) {
                        // No popup
                    }
                    
                    const resultsFound = await waitForSearchResults(page, log);
                    
                    if (!resultsFound) {
                        log.warning('⚠️ No search results detected');
                        await debugPageState(page, log, 'no-results');
                        return;
                    }
                    
                    await autoScroll(page, log, scrollCount);
                    
                    const products = await extractZeptoProducts(page, log);
                    
                    if (products.length === 0) {
                        log.error('❌ No products extracted');
                        await debugPageState(page, log, 'no-products');
                        return;
                    }
                    
                    const urlParams = new URL(url).searchParams;
                    const searchQuery = urlParams.get('query');
                    
                    const productsToSave = products.slice(0, maxProductsPerSearch).map(product => ({
                        ...product,
                        searchQuery,
                        searchUrl: url,
                        platform: 'Zepto',
                        pincode
                    }));
                    
                    await Dataset.pushData(productsToSave);
                    
                    log.info(`✅ Saved ${productsToSave.length} products for "${searchQuery}"`);

                } catch (error) {
                    log.error(`❌ Error: ${error.message}`);
                    
                    if (screenshotOnError) {
                        try {
                            const screenshot = await page.screenshot({ fullPage: false });
                            await Actor.setValue(`error-${Date.now()}.png`, screenshot, { contentType: 'image/png' });
                        } catch (e) {
                            log.error(`Failed screenshot: ${e.message}`);
                        }
                    }
                    
                    throw error;
                }
            },

            failedRequestHandler: async ({ request, log }) => {
                log.error(`❌ Request failed: ${request.url}`);
                
                const failedUrls = await Actor.getValue('FAILED_URLS') || [];
                failedUrls.push({
                    url: request.url,
                    timestamp: new Date().toISOString()
                });
                await Actor.setValue('FAILED_URLS', failedUrls);
            }
        });

        let locationSetGlobally = false;

        // Start crawler
        if (allSearchUrls.length > 0) {
            console.log('\n🚀 Starting Zepto Scraper');
            console.log(`📍 Pincode: ${pincode}`);
            console.log(`🔍 Search URLs: ${allSearchUrls.length}`);
            console.log(`📊 Max products: ${maxProductsPerSearch}`);
            console.log(`📜 Scroll count: ${scrollCount}\n`);
            
            const searchRequests = allSearchUrls.map((url, index) => ({ 
                url, 
                userData: { isFirst: index === 0 } 
            }));
            
            await crawler.run(searchRequests);
            
            console.log('\n✅ Scraping completed successfully!');
            console.log('📁 Check storage/datasets/default/ for results\n');
        } else {
            console.log('❌ No search URLs or queries provided!');
            console.log('Please provide "searchUrls" or "searchQueries" in input\n');
        }

        // Ensure proper exit
        await gracefulExit(0);

    } catch (error) {
        console.error('FATAL ERROR:', error?.stack || error);
        await Actor.setValue('FATAL_ERROR', error?.stack || String(error));
        await gracefulExit(1);
    }
}

// Run main function
main().catch(async (error) => {
    console.error('Unhandled error in main:', error);
    await gracefulExit(1);
});
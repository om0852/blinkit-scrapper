import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

// Wrap everything in async IIFE with proper exit handling
(async () => {
    try {
        await Actor.init();

        const input = await Actor.getInput();

        const {
            searchUrls = [],
            searchQueries = [],
            deliveryLocation = null,
            pincode = null,
            maxProductsPerSearch = 100,
            proxyConfiguration = { useApifyProxy: false },
            maxRequestRetries = 3,
            maxConcurrency = 2,
            navigationTimeout = 60000, // Reduced from 90s
            headless = true,
            screenshotOnError = true,
            debugMode = false,
            scrollCount = 3 // Reduced from 5
        } = input || {};

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

        const allSearchUrls = [
            ...searchUrls,
            ...searchQueries.map(query => `https://blinkit.com/s/?q=${encodeURIComponent(query)}`)
        ];

        const proxyConfig = proxyConfiguration?.useApifyProxy
            ? await Actor.createProxyConfiguration(proxyConfiguration)
            : undefined;

        const customProxyUrl = proxyConfiguration?.customProxyUrl || proxyConfiguration?.proxyUrl || proxyConfiguration?.proxy;
        const launchProxy = customProxyUrl ? parseProxyUrl(customProxyUrl) : null;

        // Optimized location setter
        async function setDeliveryLocation(page, log, location, pincode) {
            try {
                log.info('📍 Setting delivery location...');
                
                await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
                await page.waitForTimeout(2000); // Reduced
                
                const locationBarExists = await page.locator('div[class*="LocationBar"]').count() > 0;
                
                if (locationBarExists) {
                    const locationBar = page.locator('div[class*="LocationBar"]').first();
                    await locationBar.click({ timeout: 5000 }).catch(() => {});
                    await page.waitForTimeout(1500); // Reduced
                } else {
                    log.info('Location bar not found, looking for modal...');
                }
                
                const locationInputSelectors = [
                    'input.LocationSearchBox__InputSelect-sc-1k8u6a6-0',
                    'input[placeholder*="search delivery location"]',
                    'input[placeholder*="Search delivery location"]',
                    'input[name="select-locality"]',
                    'input[type="text"][placeholder*="location"]'
                ];
                
                let locationInput = null;
                for (const selector of locationInputSelectors) {
                    if (await page.locator(selector).count() > 0) {
                        locationInput = page.locator(selector).first();
                        log.info(`✓ Found location input: ${selector}`);
                        break;
                    }
                }
                
                if (!locationInput) {
                    log.warning('⚠️ Location input not found');
                    return false;
                }
                
                const searchText = pincode || location || 'Pune 411001';
                
                await locationInput.click({ timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(300);
                await locationInput.fill('').catch(() => {});
                await page.waitForTimeout(300);
                await locationInput.type(searchText, { delay: 80 }).catch(() => {});
                await page.waitForTimeout(1500); // Reduced
                
                const suggestionSelectors = [
                    'div.LocationSearchList__LocationListContainer-sc-93rfr7-0',
                    'div[class*="LocationSelector"]',
                    'div[role="option"]',
                    'li[role="option"]'
                ];
                
                let suggestionFound = false;
                for (const selector of suggestionSelectors) {
                    if (await page.locator(selector).count() > 0) {
                        const firstSuggestion = page.locator(selector).first();
                        try {
                            await firstSuggestion.click({ timeout: 5000 });
                            log.info(`✓ Clicked location suggestion`);
                            await page.waitForTimeout(2000); // Reduced
                            suggestionFound = true;
                            break;
                        } catch (e) {
                            continue;
                        }
                    }
                }
                
                if (!suggestionFound) {
                    await locationInput.press('Enter', { timeout: 5000 }).catch(() => {});
                    await page.waitForTimeout(2000);
                }
                
                log.info('✅ Location set successfully');
                return true;
                
            } catch (error) {
                log.error(`Error setting location: ${error.message}`);
                return false;
            }
        }

        // Optimized scroll
        async function autoScroll(page, log, scrollCount = 3) {
            try {
                for (let i = 0; i < scrollCount; i++) {
                    await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {});
                    await page.waitForTimeout(800); // Reduced
                }
                await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
                await page.waitForTimeout(500); // Reduced
            } catch (error) {
                log.warning(`Auto-scroll failed: ${error.message}`);
            }
        }

        async function debugPageState(page, log, label = 'debug') {
            if (!debugMode) return;
            
            try {
                const screenshot = await page.screenshot({ fullPage: false });
                await Actor.setValue(`${label}-${Date.now()}.png`, screenshot, { contentType: 'image/png' });
                
                const pageInfo = await page.evaluate(() => ({
                    url: window.location.href,
                    title: document.title,
                    productCount: document.querySelectorAll('div[id][role="button"].tw-relative').length
                }));
                
                log.info(`Page state: ${JSON.stringify(pageInfo)}`);
            } catch (error) {
                log.error(`Debug failed: ${error.message}`);
            }
        }

        async function waitForSearchResults(page, log) {
            const mainSelector = 'div[id][role="button"].tw-relative';
            
            try {
                await page.waitForSelector(mainSelector, { timeout: 10000 });
                const count = await page.locator(mainSelector).count();
                if (count > 0) {
                    await page.waitForTimeout(800);
                    return true;
                }
            } catch (error) {
                log.warning(`No search results found: ${error.message}`);
            }
            
            return false;
        }

        // CORRECTED EXTRACTION FUNCTION BASED ON HTML
        async function extractSearchProducts(page, log, globalDeliveryTime) {
            try {
                log.info('🔍 Starting product extraction...');
                
                // First try preloaded state
                try {
                    const preloaded = await page.evaluate(() => {
                        try {
                            return window.grofers?.PRELOADED_STATE?.data || null;
                        } catch (e) {
                            return null;
                        }
                    });

                    if (preloaded) {
                        const candidates = [];
                        if (preloaded.search && Array.isArray(preloaded.search.results)) {
                            candidates.push(...preloaded.search.results);
                        }
                        if (preloaded.plp && Array.isArray(preloaded.plp.products)) {
                            candidates.push(...preloaded.plp.products);
                        }
                        if (preloaded.widgetizedLayout && Array.isArray(preloaded.widgetizedLayout.data)) {
                            preloaded.widgetizedLayout.data.forEach(w => {
                                if (w?.data && Array.isArray(w.data.items)) {
                                    w.data.items.forEach(it => candidates.push(it.data || it));
                                }
                            });
                        }

                        if (candidates.length > 0) {
                            const parsed = candidates.map((c, i) => {
                                const title = c.title?.text || c.name || c.product_name || c.data?.title || c.data?.name || null;
                                const image = c.image?.url || c.product_image || c.image_url || c.data?.image_url || null;
                                const price = c.price || c.currentPrice || c.current_price || c.pricing?.price || null;
                                const pid = c.id || c.productId || c.product_id || c.sku || null;

                                return {
                                    productId: pid || `state-${i}`,
                                    productName: typeof title === 'string' ? title : title?.text || null,
                                    productImage: image,
                                    deliveryTime: globalDeliveryTime,
                                    currentPrice: typeof price === 'number' ? price : price?.value || null
                                };
                            }).filter(p => p.productName || p.currentPrice || p.productImage);

                            if (parsed.length > 0) {
                                log.info(`✅ Extracted ${parsed.length} products from preloaded state`);
                                return parsed;
                            }
                        }
                    }
                } catch (e) {
                    log.warning(`Could not read PRELOADED_STATE: ${e.message}`);
                }

                // DOM extraction with CORRECT selectors based on HTML
                const products = await page.evaluate((globalDeliveryTime) => {
                    const results = [];
                    // Main product card selector
                    const productCards = Array.from(document.querySelectorAll('div[id][role="button"].tw-relative.tw-flex.tw-h-full.tw-flex-col'));
                    
                    productCards.forEach((card) => {
                        try {
                            // Product ID from the card's id attribute
                            const productId = card.id || null;
                            
                            // Product Name - exact selector from HTML
                            const nameEl = card.querySelector('div.tw-text-300.tw-font-semibold.tw-line-clamp-2');
                            const productName = nameEl ? nameEl.textContent.trim() : null;
                            
                            // Product Image
                            const imgEl = card.querySelector('img');
                            const productImage = imgEl ? (imgEl.src || imgEl.getAttribute('src')) : null;
                            
                            // Current Price - exact selector from HTML
                            const priceEl = card.querySelector('div.tw-text-200.tw-font-semibold');
                            let currentPrice = null;
                            if (priceEl) {
                                const priceText = priceEl.textContent.trim();
                                const priceMatch = priceText.match(/₹\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
                                if (priceMatch) {
                                    currentPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
                                }
                            }
                            
                            // Original Price (strikethrough price)
                            const originalPriceEl = card.querySelector('div.tw-text-200.tw-font-regular.tw-line-through');
                            let originalPrice = null;
                            if (originalPriceEl) {
                                const origText = originalPriceEl.textContent.trim();
                                const origMatch = origText.match(/₹\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
                                if (origMatch) {
                                    originalPrice = parseFloat(origMatch[1].replace(/,/g, ''));
                                }
                            }
                            
                            // Product Weight/Size - exact selector from HTML
                            const weightEl = card.querySelector('div.tw-text-200.tw-font-medium.tw-line-clamp-1');
                            const productWeight = weightEl ? weightEl.textContent.trim() : null;
                            
                            // Delivery Time
                            const deliveryEl = card.querySelector('div.tw-text-050.tw-font-bold.tw-uppercase');
                            const deliveryTime = globalDeliveryTime || (deliveryEl ? deliveryEl.textContent.trim() : null);
                            
                            // Out of Stock status
                            const outOfStockEl = card.querySelector('div.tw-absolute.tw-bottom-1\\/2.tw-right-1\\/2');
                            const isOutOfStock = outOfStockEl && outOfStockEl.textContent.includes('Out of Stock');
                            
                            // Discount calculation
                            let discountPercentage = null;
                            if (currentPrice && originalPrice && originalPrice > currentPrice) {
                                discountPercentage = Math.round(((originalPrice - currentPrice) / originalPrice) * 100);
                            }
                            
                            // Only add if we have essential data
                            if (productName || currentPrice || productImage) {
                                results.push({
                                    productId: productId || `blinkit-${results.length}`,
                                    productName,
                                    productImage,
                                    currentPrice,
                                    originalPrice,
                                    discountPercentage,
                                    productWeight,
                                    deliveryTime,
                                    isOutOfStock: isOutOfStock || false,
                                    scrapedAt: new Date().toISOString()
                                });
                            }
                        } catch (err) {
                            console.error('Error processing product card:', err);
                        }
                    });

                    return results;
                }, globalDeliveryTime);

                log.info(`✅ Extracted ${products.length} products from DOM`);
                
                if (products.length > 0 && debugMode) {
                    console.log('Sample product:', JSON.stringify(products[0], null, 2));
                }
                
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
            maxConcurrency,
            navigationTimeoutSecs: navigationTimeout / 1000,
            headless,
            
            launchContext: {
                launchOptions: {
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--disable-dev-shm-usage',
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-gpu'
                    ],
                    ...((!proxyConfig && launchProxy) ? { proxy: launchProxy } : {})
                }
            },

            preNavigationHooks: [
                async ({ page, log }) => {
                    try {
                        const ua = pickRandom(USER_AGENTS);

                        await page.setExtraHTTPHeaders({
                            'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
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
                try {
                    const { url } = request;
                    const { userData = {} } = request;
                    const { isFirstRequest = false } = userData;

                    log.info(`🔍 Processing: ${url}`);

                    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
                    await page.waitForTimeout(3000); // Reduced
                    
                    if ((pincode || deliveryLocation) && isFirstRequest) {
                        await setDeliveryLocation(page, log, deliveryLocation, pincode);
                        await page.waitForTimeout(2000); // Reduced
                    }
                    
                    if (debugMode) {
                        await debugPageState(page, log, 'search-initial').catch(() => {});
                    }
                    
                    // Close popups
                    try {
                        const closeButtons = page.locator('button:has-text("Close"), button:has-text("×"), [aria-label="Close"]');
                        if (await closeButtons.count() > 0) {
                            await closeButtons.first().click({ timeout: 2000 });
                            await page.waitForTimeout(800);
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
                    
                    // Extract global delivery time
                    let globalDeliveryTime = null;
                    try {
                        const deliveryTimeEl = page.locator('div[class*="LocationBar__Title"]');
                        if (await deliveryTimeEl.count() > 0) {
                            globalDeliveryTime = await deliveryTimeEl.first().textContent();
                            log.info(`✓ Found global delivery time: ${globalDeliveryTime}`);
                        }
                    } catch (e) {
                        log.warning(`Could not extract global delivery time: ${e.message}`);
                    }

                    const products = await extractSearchProducts(page, log, globalDeliveryTime);
                    
                    if (products.length === 0) {
                        log.warning('⚠️ No products extracted');
                        await debugPageState(page, log, 'no-products');
                        return;
                    }
                    
                    const urlParams = new URL(url).searchParams;
                    const searchQuery = urlParams.get('q');
                    
                    let currentLocation = deliveryLocation || pincode || 'Unknown';
                    try {
                        const locationText = await page.locator('div[class*="LocationBar__Subtitle"]').first().textContent({ timeout: 2000 });
                        currentLocation = locationText.trim();
                    } catch (e) {
                        // Use fallback
                    }
                    
                    const productsToSave = products.slice(0, maxProductsPerSearch).map(product => ({
                        ...product,
                        searchQuery,
                        requestedPincode: pincode,
                        deliveryLocation: currentLocation,
                        platform: 'Blinkit'
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
                            // Ignore
                        }
                    }
                    
                    throw error;
                }
            },

            failedRequestHandler: async ({ request, log }) => {
                log.error(`❌ Request failed: ${request.url}`);
                
                try {
                    const failedUrls = await Actor.getValue('FAILED_URLS') || [];
                    failedUrls.push({
                        url: request.url,
                        timestamp: new Date().toISOString()
                    });
                    await Actor.setValue('FAILED_URLS', failedUrls);
                } catch (e) {
                    log.error(`Failed to save failed URL: ${e.message}`);
                }
            }
        });

        // Start crawler
        if (allSearchUrls.length > 0) {
            console.log('\n🚀 Starting Blinkit Scraper');
            console.log(`🔍 URLs: ${allSearchUrls.length}`);
            console.log(`📍 Location: ${deliveryLocation || pincode || 'Default'}`);
            console.log(`📊 Max products: ${maxProductsPerSearch}`);
            console.log(`📜 Scroll count: ${scrollCount}\n`);
            
            const requests = allSearchUrls.map((url, index) => ({
                url,
                userData: { isFirstRequest: index === 0 }
            }));
            
            await crawler.run(requests);
            
            console.log('\n✅ Scraping completed successfully!\n');
        } else {
            console.log('❌ No URLs provided!\n');
        }

        // Proper exit
        await Actor.exit();
        
    } catch (error) {
        console.error('FATAL ERROR:', error);
        try {
            await Actor.setValue('FATAL_ERROR', error?.stack || String(error));
            await Actor.exit(1);
        } catch (e) {
            process.exit(1);
        }
    }
})();
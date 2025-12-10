import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();

const {
    searchUrls = [],
    searchQueries = [],
    maxProductsPerSearch = 100,
    proxyConfiguration = { useApifyProxy: false },
    maxRequestRetries = 3,
    navigationTimeout = 90000,
    headless = false,
    screenshotOnError = true,
    debugMode = true,
    scrollCount = 5
} = input;

// Generate search URLs from queries if provided
const allSearchUrls = [
    ...searchUrls,
    ...searchQueries.map(query => `https://blinkit.com/s/?q=${encodeURIComponent(query)}`)
];

const proxyConfig = proxyConfiguration.useApifyProxy
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : undefined;

// Auto-scroll to load lazy products
async function autoScroll(page, log, scrollCount = 5, scrollContainerSelector = null) {
    try {
        log.info(`Starting auto-scroll (${scrollCount} iterations) for ${scrollContainerSelector || 'window'}...`);

        for (let i = 0; i < scrollCount; i++) {
            if (scrollContainerSelector) {
                const scrolled = await page.evaluate((selector) => {
                    const container = document.querySelector(selector);
                    if (container) {
                        container.scrollTop += container.clientHeight;
                        return true;
                    }
                    return false;
                }, scrollContainerSelector);

                if (!scrolled) {
                    // Fallback to window scroll if container not found
                    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                }
            } else {
                await page.evaluate(() => {
                    window.scrollBy(0, window.innerHeight);
                });
            }

            log.info(`Scroll ${i + 1}/${scrollCount}`);
            await page.waitForTimeout(1500);
        }

        // Scroll back to top
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(1000);

        log.info('Auto-scroll completed');
    } catch (error) {
        log.warning(`Auto-scroll failed: ${error.message}`);
    }
}

// Debug page state
async function debugPageState(page, log, label = 'debug') {
    try {
        const screenshot = await page.screenshot({ fullPage: true });
        await Actor.setValue(`${label}-screenshot-${Date.now()}.png`, screenshot, { contentType: 'image/png' });

        const html = await page.content();
        await Actor.setValue(`${label}-html-${Date.now()}.html`, html, { contentType: 'text/html' });

        const pageInfo = await page.evaluate(() => {
            return {
                url: window.location.href,
                title: document.title,
                elementCounts: {
                    productCardsById: document.querySelectorAll('div[id][role="button"].tw-relative.tw-flex.tw-h-full.tw-flex-col').length,
                    productTitles: document.querySelectorAll('div.tw-text-300.tw-font-semibold.tw-line-clamp-2').length,
                    priceElements: document.querySelectorAll('div.tw-text-200.tw-font-semibold').length,
                    weightElements: document.querySelectorAll('div.tw-text-200.tw-font-medium.tw-line-clamp-1').length,
                    addButtons: Array.from(document.querySelectorAll('div[role="button"]')).filter(el => (el.textContent || '').includes('ADD')).length,
                    images: document.querySelectorAll('img').length
                }
            };
        });

        log.info(`Page state: ${JSON.stringify(pageInfo, null, 2)}`);
        return pageInfo;
    } catch (error) {
        log.error(`Debug failed: ${error.message}`);
    }
}

// Wait for search results to load
async function waitForSearchResults(page, log) {
    const selectors = [
        'div[id][role="button"].tw-relative',
        'div.tw-text-300.tw-font-semibold.tw-line-clamp-2',
        'div.tw-text-200.tw-font-semibold',
        'img[src*="cdn.grofers.com"]'
    ];

    log.info('Waiting for search results to load...');

    for (const selector of selectors) {
        try {
            await page.waitForSelector(selector, { timeout: 15000 });
            const count = await page.locator(selector).count();
            log.info(`✓ Found ${count} elements matching: ${selector}`);

            if (count > 0) {
                await page.waitForTimeout(2000);
                return true;
            }
        } catch (error) {
            log.warning(`Selector ${selector} not found: ${error.message}`);
        }
    }

    log.warning('No search result selectors found');
    return false;
}

// Set location based on pincode
async function setLocation(page, log, pincode) {
    try {
        log.info(`📍 Setting location to pincode: ${pincode}`);

        // Wait for page to be ready
        await page.waitForTimeout(2000);

        // Look for the location bar/button to click
        const locationBarSelectors = [
            '.LocationBar__Container-sc-x8ezho-6',
            '.LocationBar__SubtitleContainer-sc-x8ezho-9',
            'div:has-text("Delivery in")',
            '[class*="LocationBar"]'
        ];

        let locationButtonClicked = false;
        for (const selector of locationBarSelectors) {
            try {
                const locationBar = page.locator(selector).first();
                const count = await locationBar.count();
                if (count > 0) {
                    log.info(`✓ Found location bar with selector: ${selector}`);
                    await locationBar.click();
                    locationButtonClicked = true;
                    log.info('✓ Clicked location bar');
                    await page.waitForTimeout(2000);
                    break;
                }
            } catch (e) {
                log.debug(`Location bar selector ${selector} not found`);
            }
        }

        if (!locationButtonClicked) {
            log.warning('⚠️ Could not find location bar, trying to proceed without changing location');
            return false;
        }

        // Wait for the location modal to appear
        const modalSelectors = [
            '.LocationSelectorDesktopV1__DetectLocationContainer-sc-19zschz-2',
            '.location-show-addresses-v1',
            'div:has-text("Change Location")',
            'input[placeholder*="location"]',
            'input[name="select-locality"]'
        ];

        let modalFound = false;
        for (const selector of modalSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
                log.info(`✓ Location modal opened (found: ${selector})`);
                modalFound = true;
                break;
            } catch (e) {
                log.debug(`Modal selector ${selector} not found`);
            }
        }

        if (!modalFound) {
            log.warning('⚠️ Location modal did not open');
            return false;
        }

        // Find and fill the pincode input field
        const inputSelectors = [
            'input[name="select-locality"]',
            'input[placeholder*="location"]',
            'input[placeholder*="search"]',
            '.LocationSearchBox__InputSelect-sc-1k8u6a6-0'
        ];

        let inputFilled = false;
        for (const selector of inputSelectors) {
            try {
                const input = page.locator(selector).first();
                const count = await input.count();
                if (count > 0) {
                    log.info(`✓ Found pincode input with selector: ${selector}`);

                    // Clear existing value
                    await input.click();
                    await page.waitForTimeout(500);
                    await input.fill('');
                    await page.waitForTimeout(500);

                    // Type the pincode
                    await input.fill(pincode);
                    await page.waitForTimeout(1000);

                    log.info(`✓ Entered pincode: ${pincode}`);
                    inputFilled = true;
                    break;
                }
            } catch (e) {
                log.debug(`Input selector ${selector} not found: ${e.message}`);
            }
        }

        if (!inputFilled) {
            log.warning('⚠️ Could not fill pincode input');
            return false;
        }

        // Wait for location suggestions to appear
        await page.waitForTimeout(2000);

        // Click on the first location suggestion
        const locationListSelectors = [
            '.LocationSearchList__LocationListContainer-sc-93rfr7-0',
            '.address-container-v1 > div:first-child',
            'div[class*="LocationList"]',
            '.location-addresses-v1 > div > div:first-child'
        ];

        let locationSelected = false;
        for (const selector of locationListSelectors) {
            try {
                const locationItems = page.locator(selector);
                const count = await locationItems.count();

                if (count > 0) {
                    log.info(`✓ Found ${count} location suggestions with selector: ${selector}`);

                    // Click the first matching location
                    await locationItems.first().click();
                    log.info('✓ Selected first location from suggestions');
                    locationSelected = true;
                    await page.waitForTimeout(3000);
                    break;
                }
            } catch (e) {
                log.debug(`Location list selector ${selector} not found: ${e.message}`);
            }
        }

        if (!locationSelected) {
            log.warning('⚠️ Could not select location from suggestions, trying to continue anyway');

            // Try pressing Enter to confirm
            try {
                await page.keyboard.press('Enter');
                await page.waitForTimeout(2000);
                log.info('✓ Pressed Enter to confirm location');
            } catch (e) {
                log.warning('Could not press Enter');
            }
        }

        // Verify location was set by checking if modal closed
        await page.waitForTimeout(2000);

        log.info(`✅ Location set successfully to pincode: ${pincode}`);
        return true;

    } catch (error) {
        log.error(`❌ Error setting location: ${error.message}`);
        log.warning('⚠️ Continuing without location change - results may be for default location');

        // Try to close modal if it's still open
        try {
            const closeButton = page.locator('button:has(span.icon-cross)').first();
            const count = await closeButton.count();
            if (count > 0) {
                await closeButton.click();
                log.info('✓ Closed location modal');
            }
        } catch (e) {
            // Ignore
        }

        return false;
    }
}

// ENHANCED: Extract products with ALL available information
async function extractSearchProducts(page, log) {
    try {
        log.info('🔍 Starting ENHANCED product extraction from search results...');

        const products = await page.evaluate(() => {
            const productCards = [];

            // Helper function to convert product name to URL slug
            function createSlug(name) {
                if (!name) return 'product';
                return name
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, '');
            }

            // Find all product cards
            const productItems = document.querySelectorAll('div[id][role="button"][tabindex="0"].tw-relative.tw-flex.tw-h-full.tw-flex-col');
            console.log(`Found ${productItems.length} product cards with ID attribute`);

            productItems.forEach((item, index) => {
                try {
                    // Extract product ID from the div id attribute
                    const productId = item.id;

                    // Get all text content for searching
                    const allText = item.innerText || item.textContent;

                    // Check if product is out of stock FIRST (before other extractions)
                    // Using text content check instead of :has-text() which doesn't work in querySelector
                    const isOutOfStock = !!(
                        allText.includes('Out of Stock') ||
                        item.querySelector('div.tw-absolute.tw-bg-grey-500') ||
                        item.querySelector('img.tw-opacity-\\[0\\.6\\]') ||
                        item.querySelector('div.tw-opacity-\\[0\\.6\\] img') ||
                        // Check for the "Out of Stock" overlay badge
                        Array.from(item.querySelectorAll('div.tw-absolute')).some(el =>
                            (el.textContent || '').includes('Out of Stock')
                        )
                    );

                    // Extract product name - handle out of stock greyed out text
                    const titleElement = item.querySelector('div.tw-text-300.tw-font-semibold.tw-line-clamp-2');
                    const productName = titleElement ? titleElement.textContent.trim() : null;

                    // Extract product image (high resolution) - works for both in-stock and out-of-stock
                    // Try multiple strategies to find the image
                    let productImage = null;

                    // Strategy 1: Look for cdn.grofers.com images (most common)
                    const imgElement = item.querySelector('img[src*="cdn.grofers.com"]');
                    if (imgElement) {
                        productImage = imgElement.src || imgElement.getAttribute('src');
                    }

                    // Strategy 2: If not found, try any img tag in the product card
                    if (!productImage) {
                        const anyImg = item.querySelector('img');
                        if (anyImg) {
                            productImage = anyImg.src || anyImg.getAttribute('src');
                        }
                    }

                    // Strategy 3: Check for lazy-loaded images with data-src attribute
                    if (!productImage) {
                        const lazyImg = item.querySelector('img[data-src]');
                        if (lazyImg) {
                            productImage = lazyImg.getAttribute('data-src') || lazyImg.src;
                        }
                    }

                    // Strategy 4: Look for background images in div elements
                    if (!productImage) {
                        const bgImgDiv = item.querySelector('div[style*="background-image"]');
                        if (bgImgDiv) {
                            const style = bgImgDiv.getAttribute('style');
                            const urlMatch = style.match(/url\(['"]?(.*?)['"]?\)/);
                            if (urlMatch && urlMatch[1]) {
                                productImage = urlMatch[1];
                            }
                        }
                    }

                    // Strategy 5: Look in the image container specifically
                    if (!productImage) {
                        const imgContainer = item.querySelector('div.tw-relative.tw-w-full.tw-overflow-hidden img');
                        if (imgContainer) {
                            productImage = imgContainer.src || imgContainer.getAttribute('src') || imgContainer.getAttribute('data-src');
                        }
                    }

                    // Strategy 6: Check for srcset attribute
                    if (!productImage) {
                        const imgWithSrcset = item.querySelector('img[srcset]');
                        if (imgWithSrcset) {
                            const srcset = imgWithSrcset.getAttribute('srcset');
                            // Extract first URL from srcset
                            if (srcset) {
                                const firstUrl = srcset.split(',')[0].trim().split(' ')[0];
                                productImage = firstUrl;
                            }
                        }
                    }

                    // Upgrade to higher resolution if we found an image
                    if (productImage) {
                        // Convert to full URL if it's relative
                        if (productImage.startsWith('//')) {
                            productImage = 'https:' + productImage;
                        } else if (productImage.startsWith('/')) {
                            productImage = 'https://blinkit.com' + productImage;
                        }

                        // Try to get higher resolution image
                        if (productImage.includes('w=270')) {
                            productImage = productImage.replace('w=270', 'w=540');
                        } else if (productImage.includes('w=135')) {
                            productImage = productImage.replace('w=135', 'w=540');
                        }
                    }

                    // Extract weight/quantity - works for both in-stock and out-of-stock
                    const weightElement = item.querySelector('div.tw-flex.tw-items-center div.tw-text-200.tw-font-medium.tw-line-clamp-1');
                    const productWeight = weightElement ? weightElement.textContent.trim() : null;

                    // Extract prices (current and original) - handle greyed out prices for out-of-stock
                    const priceElements = item.querySelectorAll('div.tw-text-200.tw-font-semibold, div.tw-text-grey-600.tw-text-200.tw-font-semibold');
                    let currentPrice = null;
                    let originalPrice = null;

                    priceElements.forEach(priceEl => {
                        const priceText = priceEl.textContent.trim();
                        if (priceText.includes('₹') && !priceEl.classList.contains('tw-line-through')) {
                            const priceMatch = priceText.match(/₹\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
                            if (priceMatch && !currentPrice) {
                                currentPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
                            }
                        }
                    });

                    // Extract original/strikethrough price
                    const originalPriceElement = item.querySelector('div.tw-text-200.tw-font-regular.tw-line-through');
                    if (originalPriceElement) {
                        const originalPriceText = originalPriceElement.textContent.trim();
                        const originalPriceMatch = originalPriceText.match(/₹\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
                        if (originalPriceMatch) {
                            originalPrice = parseFloat(originalPriceMatch[1].replace(/,/g, ''));
                        }
                    }

                    // Extract discount percentage
                    let discountPercentage = null;

                    // Look for discount badge text (e.g., "10% OFF")
                    const discountMatch = allText.match(/(\d+)%\s*OFF/i);
                    if (discountMatch) {
                        discountPercentage = parseInt(discountMatch[1]);
                    }

                    // If no discount badge but we have original price, calculate it
                    if (!discountPercentage && currentPrice && originalPrice && originalPrice > currentPrice) {
                        discountPercentage = Math.round(((originalPrice - currentPrice) / originalPrice) * 100);
                    }

                    // Extract delivery time
                    let deliveryTime = null;
                    const deliveryElement = item.querySelector('div.tw-text-050.tw-font-bold.tw-uppercase');
                    if (deliveryElement) {
                        deliveryTime = deliveryElement.textContent.trim();
                    } else {
                        const deliveryMatch = allText.match(/(\d+\s*MINS?)/i);
                        if (deliveryMatch) {
                            deliveryTime = deliveryMatch[1];
                        }
                    }

                    // Extract rating if available
                    let rating = null;
                    const ratingElement = item.querySelector('[class*="rating"], [class*="star"]');
                    if (ratingElement) {
                        const ratingText = ratingElement.textContent.trim();
                        const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)/);
                        if (ratingMatch) {
                            rating = parseFloat(ratingMatch[1]);
                        }
                    }

                    // Extract product highlights/features (green text with checkmark icon)
                    let highlights = [];
                    const highlightElements = item.querySelectorAll('div.tw-text-base-green, div.tw-text-green-700');
                    highlightElements.forEach(el => {
                        const text = el.textContent.trim();
                        if (text && text.length > 0 && !text.includes('₹') && !text.includes('MINS')) {
                            highlights.push(text);
                        }
                    });

                    // Extract badge/tag information (like "Best Seller", "New", etc.)
                    let badges = [];
                    const badgeElements = item.querySelectorAll('div[class*="badge"], div[class*="tag"]');
                    badgeElements.forEach(badge => {
                        const badgeText = badge.textContent.trim();
                        if (badgeText && badgeText.length > 0 && !badges.includes(badgeText)) {
                            badges.push(badgeText);
                        }
                    });

                    // Construct product URL
                    let productUrl = null;
                    const linkElement = item.querySelector('a[href*="/prn/"]');
                    if (linkElement) {
                        productUrl = linkElement.href;
                    } else if (productId && productName) {
                        // Construct URL: https://blinkit.com/prn/{product-slug}/prid/{productId}
                        const slug = createSlug(productName);
                        productUrl = `https://blinkit.com/prn/${slug}/prid/${productId}`;
                    }

                    // Extract availability/stock status message
                    let stockMessage = null;
                    if (isOutOfStock) {
                        stockMessage = "Out of Stock";
                    } else {
                        const addButtons = Array.from(item.querySelectorAll('div[role="button"]'));
                        const addButton = addButtons.find(el => (el.textContent || '').includes('ADD'));
                        if (addButton) {
                            stockMessage = "In Stock";
                        }
                    }

                    // Extract options/variants if available (e.g., "2 options")
                    let hasVariants = false;
                    let variantCount = null;
                    const smallTexts = Array.from(item.querySelectorAll('div.tw-text-050'));
                    const variantElement = smallTexts.find(el => (el.textContent || '').match(/\d+\s*option/i));

                    if (variantElement) {
                        hasVariants = true;
                        const variantMatch = variantElement.textContent.match(/(\d+)\s*option/i);
                        if (variantMatch) {
                            variantCount = parseInt(variantMatch[1]);
                        }
                    }

                    // Extract all raw text for additional context
                    const rawText = allText.replace(/\s+/g, ' ').trim();

                    // Calculate savings if we have both prices
                    let savings = null;
                    if (currentPrice && originalPrice && originalPrice > currentPrice) {
                        savings = originalPrice - currentPrice;
                    }

                    // IMPORTANT: Include ALL products - both in stock and out of stock
                    // Only skip if we have NO useful data at all
                    if (productName || currentPrice || productImage || productId) {
                        const product = {
                            // Core identification
                            productId: productId || `product-${index}`,
                            productName,
                            productUrl,

                            // Visual
                            productImage,

                            // Pricing
                            currentPrice,
                            originalPrice,
                            discountPercentage,
                            savings,

                            // Product details
                            productWeight,

                            // Availability - THIS IS KEY!
                            isOutOfStock,
                            stockMessage,
                            deliveryTime,

                            // Additional info
                            rating,
                            highlights: highlights.length > 0 ? highlights : null,
                            badges: badges.length > 0 ? badges : null,
                            hasVariants,
                            variantCount,

                            // Metadata
                            rawText,
                            scrapedAt: new Date().toISOString()
                        };

                        productCards.push(product);

                        // Log extraction for debugging
                        if (index < 3) {
                            console.log(`Product ${index + 1}: ${productName} - ${isOutOfStock ? '🔴 OUT OF STOCK' : '🟢 IN STOCK'}`);
                        }
                    }
                } catch (err) {
                    console.error(`Error processing product ${index}:`, err);
                }
            });

            // Fallback method if primary extraction fails
            if (productCards.length === 0) {
                console.log('Primary extraction found 0 products, trying fallback...');

                const alternativeItems = document.querySelectorAll('div[role="button"][tabindex="0"]');
                console.log(`Found ${alternativeItems.length} alternative product containers`);

                alternativeItems.forEach((item, index) => {
                    try {
                        const hasTitle = item.querySelector('div.tw-text-300.tw-font-semibold.tw-line-clamp-2');
                        const hasPrice = item.querySelector('div.tw-text-200.tw-font-semibold');
                        const allText = item.innerText || item.textContent;

                        // Check for out of stock in fallback too
                        const isOutOfStock = allText.includes('Out of Stock');

                        // Include products even if they don't have ADD button (out of stock won't have it)
                        if (hasTitle) {
                            const productName = hasTitle.textContent.trim();

                            let currentPrice = null;
                            if (hasPrice) {
                                const priceText = hasPrice.textContent.trim();
                                const priceMatch = priceText.match(/₹\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
                                currentPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;
                            }

                            // Enhanced image extraction for fallback
                            let productImage = null;

                            // Try multiple strategies
                            const img1 = item.querySelector('img[src*="cdn.grofers.com"]');
                            const img2 = item.querySelector('img');
                            const img3 = item.querySelector('img[data-src]');

                            if (img1) {
                                productImage = img1.src || img1.getAttribute('src');
                            } else if (img2) {
                                productImage = img2.src || img2.getAttribute('src') || img2.getAttribute('data-src');
                            } else if (img3) {
                                productImage = img3.getAttribute('data-src');
                            }

                            // Check for srcset
                            if (!productImage) {
                                const imgWithSrcset = item.querySelector('img[srcset]');
                                if (imgWithSrcset) {
                                    const srcset = imgWithSrcset.getAttribute('srcset');
                                    if (srcset) {
                                        productImage = srcset.split(',')[0].trim().split(' ')[0];
                                    }
                                }
                            }

                            // Normalize URL
                            if (productImage) {
                                if (productImage.startsWith('//')) {
                                    productImage = 'https:' + productImage;
                                } else if (productImage.startsWith('/')) {
                                    productImage = 'https://blinkit.com' + productImage;
                                }

                                // Upgrade resolution
                                if (productImage.includes('w=270')) {
                                    productImage = productImage.replace('w=270', 'w=540');
                                } else if (productImage.includes('w=135')) {
                                    productImage = productImage.replace('w=135', 'w=540');
                                }
                            }

                            const weightEl = item.querySelector('div.tw-text-200.tw-font-medium.tw-line-clamp-1');
                            const productWeight = weightEl ? weightEl.textContent.trim() : null;

                            const productId = item.id || `fallback-${index}`;
                            const slug = createSlug(productName);

                            productCards.push({
                                productId,
                                productName,
                                productUrl: `https://blinkit.com/prn/${slug}/prid/${productId}`,
                                productImage,
                                currentPrice,
                                productWeight,
                                isOutOfStock,
                                stockMessage: isOutOfStock ? "Out of Stock" : "In Stock",
                                scrapedAt: new Date().toISOString()
                            });

                            console.log(`Fallback extracted: ${productName} - ${isOutOfStock ? '🔴 OUT OF STOCK' : '🟢 IN STOCK'} - Image: ${productImage ? '✅' : '❌'}`);
                        }
                    } catch (err) {
                        console.error('Error in fallback extraction:', err);
                    }
                });
            }

            return productCards;
        });

        log.info(`✅ Extracted ${products.length} products with complete data from search results`);

        // Count in-stock vs out-of-stock
        const inStockCount = products.filter(p => !p.isOutOfStock).length;
        const outOfStockCount = products.filter(p => p.isOutOfStock).length;
        const withImages = products.filter(p => p.productImage).length;
        const withoutImages = products.filter(p => !p.productImage).length;

        log.info(`   🟢 In Stock: ${inStockCount}`);
        log.info(`   🔴 Out of Stock: ${outOfStockCount}`);
        log.info(`   🖼️  With Images: ${withImages}`);
        log.info(`   ❌ Missing Images: ${withoutImages}`);

        // Log products without images for debugging
        if (withoutImages > 0 && debugMode) {
            console.log('⚠️ Products missing images:');
            products.filter(p => !p.productImage).slice(0, 5).forEach(p => {
                console.log(`   - ${p.productName || p.productId}`);
            });
        }

        // Log detailed sample product for debugging
        if (products.length > 0 && debugMode) {
            console.log('=== SAMPLE PRODUCT (Full Data) ===');
            console.log(JSON.stringify(products[0], null, 2));
            console.log('================================');

            // Show an out-of-stock example if available
            const outOfStockExample = products.find(p => p.isOutOfStock);
            if (outOfStockExample) {
                console.log('=== SAMPLE OUT-OF-STOCK PRODUCT ===');
                console.log(JSON.stringify(outOfStockExample, null, 2));
                console.log('===================================');
            }
        }

        return products;
    } catch (error) {
        log.error(`Error extracting search products: ${error.message}`);
        log.error(`Stack: ${error.stack}`);
        return [];
    }
}

// Initialize the crawler
const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries,
    navigationTimeoutSecs: navigationTimeout / 1000,
    requestHandlerTimeoutSecs: 300, // Increased timeout to 5 minutes to allow for long scrolling
    headless,

    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security'
            ]
        }
    },

    preNavigationHooks: [
        async ({ page }) => {
            await page.context().setGeolocation({
                latitude: 18.5204,
                longitude: 73.8567
            });

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });

            await page.setViewportSize({ width: 1920, height: 1080 });

            // Forward page console messages for debugging
            page.on('console', msg => {
                try {
                    const text = msg.text();
                    const type = msg.type();
                    console.log(`[page:${type}] ${text}`);
                } catch (e) {
                    // ignore
                }
            });
        }
    ],

    async requestHandler({ page, request, log }) {
        const { url } = request;

        log.info(`🔍 Processing search URL: ${url}`);

        try {
            // Wait for page to load
            await page.waitForLoadState('domcontentloaded');
            await page.waitForTimeout(5000);

            if (debugMode) {
                log.info('📸 Taking initial debug snapshot...');
                await debugPageState(page, log, 'search-initial');
            }

            // STEP 1: Handle Location Selection
            await setLocation(page, log, input.pincode || '411001');

            // STEP 2: Close any remaining popups
            try {
                const closeButtons = page.locator('button:has-text("Close"), button:has-text("×"), [aria-label="Close"]');
                const count = await closeButtons.count();
                if (count > 0) {
                    await closeButtons.first().click();
                    log.info('✓ Closed popup');
                    await page.waitForTimeout(1000);
                }
            } catch (e) {
                // No popup
            }

            // Wait for search results
            const resultsFound = await waitForSearchResults(page, log);

            if (!resultsFound) {
                log.warning('⚠️ No search results detected');
                if (debugMode) {
                    await debugPageState(page, log, 'no-results');
                }
            }

            // Scroll to load more products
            const isSearchQuery = url.includes('/s/?q=');
            // If it's a direct URL (not a search query), try to scroll the container
            const scrollSelector = isSearchQuery ? null : '#plpContainer';

            await autoScroll(page, log, scrollCount, scrollSelector);

            if (debugMode) {
                await debugPageState(page, log, 'after-scroll');
            }

            // Extract products with ALL information
            const products = await extractSearchProducts(page, log);

            if (products.length === 0) {
                log.error('❌ No products extracted! Check debug screenshots.');
                return;
            }

            // Extract search query from URL
            let searchQuery = null;
            const urlParams = new URL(url).searchParams;
            searchQuery = urlParams.get('q');

            // Add search metadata and platform info to each product
            let savedCount = 0;
            for (const product of products.slice(0, maxProductsPerSearch)) {
                product.searchQuery = searchQuery;
                product.searchUrl = url;
                product.platform = 'Blinkit';
                product.requestedPincode = input.pincode || '411001';

                await Dataset.pushData(product);
                savedCount++;

                const stockStatus = product.isOutOfStock ? '🔴 OUT OF STOCK' : '🟢 IN STOCK';
                const priceInfo = product.originalPrice
                    ? `₹${product.currentPrice} (was ₹${product.originalPrice}, ${product.discountPercentage}% off)`
                    : `₹${product.currentPrice}`;

                log.info(`💾 [${savedCount}/${Math.min(products.length, maxProductsPerSearch)}] ${stockStatus} ${product.productName || product.productId} - ${priceInfo}`);
            }

            // Summary statistics
            const inStock = products.filter(p => !p.isOutOfStock).length;
            const outOfStock = products.filter(p => p.isOutOfStock).length;
            const withDiscount = products.filter(p => p.discountPercentage).length;
            const avgPrice = products.filter(p => p.currentPrice).reduce((sum, p) => sum + p.currentPrice, 0) / products.filter(p => p.currentPrice).length;

            log.info(`
✅ SCRAPING COMPLETED!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Summary for query: "${searchQuery}"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Total Products: ${savedCount}
🟢 In Stock: ${inStock}
🔴 Out of Stock: ${outOfStock}
🏷️  With Discount: ${withDiscount}
💰 Avg Price: ₹${avgPrice.toFixed(2)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            `);

        } catch (error) {
            log.error(`❌ Error processing ${url}: ${error.message}`);
            log.error(`Stack: ${error.stack}`);

            if (screenshotOnError) {
                try {
                    const screenshot = await page.screenshot({ fullPage: true });
                    await Actor.setValue(`error-screenshot-${Date.now()}.png`, screenshot, { contentType: 'image/png' });
                    log.info('📸 Error screenshot saved');
                } catch (e) {
                    log.error(`Failed to capture screenshot: ${e.message}`);
                }
            }

            throw error;
        }
    },

    failedRequestHandler: async ({ request, log }) => {
        log.error(`❌ Request ${request.url} failed`);

        const failedUrls = await Actor.getValue('FAILED_URLS') || [];
        failedUrls.push({
            url: request.url,
            timestamp: new Date().toISOString()
        });
        await Actor.setValue('FAILED_URLS', failedUrls);
    }
});

// Start the crawler
if (allSearchUrls.length > 0) {
    console.log('\n🚀 Starting ENHANCED Blinkit Search Results Scraper');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🔍 Search URLs: ${allSearchUrls.length}`);
    console.log(`📍 Pincode: ${input.pincode || '411001'}`);
    console.log(`📊 Max products per search: ${maxProductsPerSearch}`);
    console.log(`📜 Scroll iterations: ${scrollCount}`);
    console.log(`🐛 Debug mode: ${debugMode}`);
    console.log(`👁️  Headless: ${headless}`);
    console.log('\n📋 Extracting Fields:');
    console.log('   • Product ID & Name');
    console.log('   • Product URL (constructed)');
    console.log('   • High-res Product Image');
    console.log('   • Current & Original Price');
    console.log('   • Discount Percentage & Savings');
    console.log('   • Product Weight/Quantity');
    console.log('   • Stock Status (In/Out of Stock)');
    console.log('   • Delivery Time');
    console.log('   • Rating');
    console.log('   • Highlights & Badges');
    console.log('   • Variants Info');
    console.log('   • Raw Text Data');
    console.log('\n🎯 Location Features:');
    console.log('   • Automatic location selection');
    console.log('   • Pincode-based delivery area');
    console.log('   • Fallback to default if location fails');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    allSearchUrls.forEach((url, idx) => {
        console.log(`  ${idx + 1}. ${url}`);
    });
    console.log('');

    await crawler.run(allSearchUrls.map(url => ({ url })));

    console.log('\n✅ SCRAPING COMPLETED SUCCESSFULLY!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📁 Results: storage/datasets/default/');
    console.log('📸 Screenshots: storage/key_value_stores/default/');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
} else {
    console.log('❌ No search URLs or queries provided!');
    console.log('Please provide either "searchUrls" or "searchQueries" in input.json\n');
}

await Actor.exit();
'use client';

import { useState } from 'react';
import { calculateDeltaManagement, OptionData, calculateNextExpirationMaxPain, calculateMaxPainForAllExpirations } from '@/lib/delta-calculator';
import DeltaVisualization from '@/components/DeltaVisualization';
import { OptionsChain } from '@/lib/options-api';

export default function Home() {
  const [ticker, setTicker] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optionsChain, setOptionsChain] = useState<OptionsChain | null>(null);
  const [deltaData, setDeltaData] = useState<any[]>([]);
  const [dataAge, setDataAge] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);

  const fetchData = async (tickerSymbol: string, live: boolean = false) => {
    setLoading(true);
    setError(null);

    try {
      // Add timeout for API calls (60 seconds - Options Basic can be slow)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      const response = await fetch(`/api/options/${tickerSymbol}?live=${live}`, {
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      const result = await response.json();

      if (!result.success) {
        const errorMsg = result.error || 'Failed to fetch options data';
        console.error('API Error:', errorMsg);
        throw new Error(errorMsg);
      }
      
      // Debug: Log if we got data
      if (result.data) {
        console.log('Data received:', {
          ticker: result.data.ticker,
          spotPrice: result.data.spotPrice,
          callsCount: result.data.calls?.length || 0,
          putsCount: result.data.puts?.length || 0,
          usingMockData: result.usingMockData
        });
      }

      // Show warning if using mock data
      if (result.usingMockData && result.warning) {
        setError(result.warning); // Show as info message, not error
      }

      const chain = result.data;
      
      // Check if we have data
      if (!chain || (!chain.calls || chain.calls.length === 0) && (!chain.puts || chain.puts.length === 0)) {
        console.warn('No options data received:', chain);
        setError(`No options data found for ${tickerSymbol}. This ticker may not have options available.`);
        setOptionsChain(null);
        setDeltaData([]);
        setDataAge(null);
        return;
      }
      
      setOptionsChain(chain);
      setDataAge(result.cache?.age || null);
      setIsLive(result.live || false);

      // Combine calls and puts
      const allOptions: OptionData[] = [
        ...chain.calls.map(c => ({
          strike: c.strike,
          openInterest: c.openInterest,
          type: 'call' as const,
          expiration: c.expiration,
        })),
        ...chain.puts.map(p => ({
          strike: p.strike,
          openInterest: p.openInterest,
          type: 'put' as const,
          expiration: p.expiration,
        })),
      ];
      
      // Check if we have any options
      if (allOptions.length === 0) {
        console.warn('No options contracts found after processing');
        setError(`No options contracts found for ${tickerSymbol}. This ticker may not have options available.`);
        setOptionsChain(null);
        setDeltaData([]);
        setDataAge(null);
        return;
      }

      // Calculate delta management
      // Uses 0.6 multiplier by default to account for:
      // - Covered call sellers (don't need hedging - they own the stock)
      // - Long positions (don't need hedging)
      // - Non-market-maker positions
      // Automatically adjusts based on put/call ratio (high call OI = more covered calls)
      const deltas = calculateDeltaManagement(
        chain.spotPrice,
        allOptions,
        0.30, // 30% implied volatility (can be made configurable)
        0.05, // 5% risk-free rate
        0.6   // Base multiplier: 60% of OI needs hedging (accounts for covered calls, long positions, etc.)
      );

      setDeltaData(deltas);
      
      // Debug: Show OI and calculations for specific strikes (BTC)
      if (tickerSymbol.toUpperCase() === 'BTC') {
        const debugStrikes = [84000, 85000];
        
        console.log('=== BTC Buy/Sell Pressure Calculation Debug ===');
        console.log('Current Price:', chain.spotPrice);
        console.log('');
        
        for (const strike of debugStrikes) {
          const putsAtStrike = chain.puts.filter(p => Math.abs(p.strike - strike) < 1);
          const callsAtStrike = chain.calls.filter(c => Math.abs(c.strike - strike) < 1);
          const deltaAtStrike = deltas.filter(d => Math.abs(d.strike - strike) < 1);
          
          const putOI = putsAtStrike.reduce((sum, p) => sum + p.openInterest, 0);
          const callOI = callsAtStrike.reduce((sum, c) => sum + c.openInterest, 0);
          
          console.log(`--- Strike $${strike} ---`);
          console.log(`Put OI: ${putOI.toLocaleString()} contracts`);
          console.log(`Call OI: ${callOI.toLocaleString()} contracts`);
          console.log(`Total OI: ${(putOI + callOI).toLocaleString()} contracts`);
          
          if (deltaAtStrike.length > 0) {
            const putDelta = deltaAtStrike.find(d => d.type === 'put');
            const callDelta = deltaAtStrike.find(d => d.type === 'call');
            
            if (putDelta) {
              console.log(`Put Delta: ${putDelta.delta.toFixed(4)}`);
              console.log(`Put Hedging Shares: ${putDelta.hedgingShares.toLocaleString()} (${putDelta.hedgingShares < 0 ? 'SELL' : 'BUY'} pressure)`);
            }
            if (callDelta) {
              console.log(`Call Delta: ${callDelta.delta.toFixed(4)}`);
              console.log(`Call Hedging Shares: ${callDelta.hedgingShares.toLocaleString()} (${callDelta.hedgingShares < 0 ? 'SELL' : 'BUY'} pressure)`);
            }
            
            const netHedging = deltaAtStrike.reduce((sum, d) => sum + d.hedgingShares, 0);
            const buyPressure = netHedging > 0 ? netHedging : 0;
            const sellPressure = netHedging < 0 ? Math.abs(netHedging) : 0;
            
            console.log(`Net Hedging: ${netHedging.toLocaleString()}`);
            console.log(`Buy Pressure: ${buyPressure.toLocaleString()} BTC`);
            console.log(`Sell Pressure: ${sellPressure.toLocaleString()} BTC`);
          }
          console.log('');
        }
        
        console.log('NOTE: Each bar in the chart shows buy/sell pressure PER STRIKE');
        console.log('Total Buy/Sell Pressure cards show the SUM across all strikes');
        console.log('================================');
      }
      
      // Calculate max pain for all expirations
      const allMaxPain = calculateMaxPainForAllExpirations(allOptions);
      if (allMaxPain.length > 0) {
        // Store all max pain results and default to next expiration
        (chain as any).allMaxPain = allMaxPain;
        (chain as any).maxPain = allMaxPain[0]; // Default to nearest expiration
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setError('Request timed out. The API may be slow or unavailable. Try again or check your internet connection.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fetch options data');
      }
      setOptionsChain(null);
      setDeltaData([]);
      setDataAge(null);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!ticker.trim()) {
      setError('Please enter a ticker symbol');
      return;
    }

    // Normalize ticker (convert aliases like "bitcoin" to "BTC")
    const { normalizeTicker } = await import('@/lib/ticker-aliases');
    const normalizedTicker = normalizeTicker(ticker.trim());
    
    // Update the input field with normalized ticker
    if (normalizedTicker !== ticker.trim().toUpperCase()) {
      setTicker(normalizedTicker);
    }

    await fetchData(normalizedTicker, false);
  };

  const handleRefresh = async () => {
    if (!ticker.trim() || !optionsChain) return;
    await fetchData(ticker.trim(), true);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200 fixed top-0 left-0 right-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-gray-900">Option Max Pain</h1>
            <div className="flex items-center gap-4">
              <a href="/trade" className="text-sm text-primary-600 hover:text-primary-700 font-medium">
                SOL Trading Bot
              </a>
              <a
                href="https://optionmaxpain.com"
                className="text-sm text-gray-600 hover:text-gray-900"
              >
                optionmaxpain.com
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 pt-24 pb-12">
        <div className="max-w-7xl mx-auto">
          {/* Hero Section */}
          <div className="text-center mb-12">
            <h2 className="text-4xl font-bold text-gray-900 mb-4">
              Max Pain Calculator & Delta Management
            </h2>
            <p className="text-lg text-gray-600 max-w-2xl mx-auto">
              Calculate max pain strike prices and visualize delta hedging pressure for stocks and crypto options
            </p>
          </div>

          {/* Search Form */}
          <div className="bg-white rounded-lg shadow-md p-8 mb-8">
            <form onSubmit={handleSubmit} className="flex gap-4">
              <div className="flex-1">
                <label htmlFor="ticker" className="block text-sm font-medium text-gray-700 mb-2">
                  Ticker Symbol
                </label>
                <input
                  id="ticker"
                  type="text"
                  value={ticker}
                  onChange={(e) => setTicker(e.target.value.toUpperCase())}
                  placeholder="Enter ticker (e.g., TSLA, BTC, AAPL)"
                  className="input"
                  disabled={loading}
                />
              </div>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={loading}
                  className="btn btn--primary px-8 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Loading...' : 'Analyze'}
                </button>
              </div>
            </form>

            {error && (
              <div className={`mt-4 p-4 rounded-lg border ${
                error.includes('mock data') || error.includes('API keys')
                  ? 'bg-yellow-50 border-yellow-200'
                  : 'bg-red-50 border-red-200'
              }`}>
                <p className={`text-sm ${
                  error.includes('mock data') || error.includes('API keys')
                    ? 'text-yellow-800'
                    : 'text-red-800'
                }`}>
                  {error}
                </p>
                {(error.includes('mock data') || error.includes('API keys')) && (
                  <a 
                    href="/README_API_KEYS.md" 
                    target="_blank"
                    className="text-yellow-700 hover:text-yellow-900 text-sm underline mt-2 inline-block"
                  >
                    Learn how to set up API keys →
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Results */}
          {optionsChain && deltaData.length > 0 && (
            <div className="mt-8">
              <div className="mb-6 flex items-center justify-between flex-wrap gap-4">
                <div>
                <h2 className="text-2xl font-bold text-gray-900 mb-2">
                  Delta Analysis for {optionsChain.ticker}
                  {optionsChain.companyName && (
                    <span className="text-lg font-normal text-gray-600 ml-2">
                      ({optionsChain.companyName})
                    </span>
                  )}
                </h2>
                  <div className="flex items-center gap-4 flex-wrap">
                    <p className="text-gray-600">
                      Based on {optionsChain.calls.length + optionsChain.puts.length} option contracts
                    </p>
                    {dataAge && (
                      <span className={`text-sm px-3 py-1 rounded-full ${
                        isLive 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {isLive ? '🟢 Live Data' : `📊 ${dataAge}`}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={handleRefresh}
                  disabled={loading}
                  className="btn btn--primary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Refreshing...' : '🔄 Refresh Live Data'}
                </button>
              </div>
              <DeltaVisualization optionsChain={optionsChain} deltaData={deltaData} />
            </div>
          )}

          {/* Info Section */}
          {!optionsChain && (
            <div className="bg-white rounded-lg shadow-md p-8">
              <h3 className="text-xl font-bold text-gray-900 mb-4">How It Works</h3>
              <div className="grid md:grid-cols-2 gap-6">
                <div>
                  <h4 className="font-semibold text-gray-900 mb-2">What is Delta?</h4>
                  <p className="text-gray-600 text-sm">
                    Delta measures how much an option's price changes when the underlying asset moves $1. 
                    Market makers who sell options need to hedge their positions to stay delta-neutral.
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold text-gray-900 mb-2">Why It Matters</h4>
                  <p className="text-gray-600 text-sm">
                    When prices move, market makers must buy or sell shares to hedge. This creates 
                    predictable buying and selling pressure at key strike levels, especially where 
                    there's high open interest.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200 mt-12">
        <div className="container mx-auto px-4 py-6">
          <p className="text-center text-sm text-gray-600">
            Options Delta Monitor - Visualize market maker hedging requirements
          </p>
        </div>
      </footer>
    </div>
  );
}


'use client';

import { useMemo, useState, useEffect } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from 'recharts';
import { DeltaData, aggregateDeltaByStrike } from '@/lib/delta-calculator';
import { OptionsChain } from '@/lib/options-api';
import { MaxPainResult } from '@/lib/delta-calculator';

interface DeltaVisualizationProps {
  optionsChain: OptionsChain;
  deltaData: DeltaData[];
}

export default function DeltaVisualization({ optionsChain, deltaData }: DeltaVisualizationProps) {
  const allMaxPain = (optionsChain as any).allMaxPain as MaxPainResult[] | undefined;
  const [selectedExpiration, setSelectedExpiration] = useState<number | null>(null);
  
  // Get max pain for selected expiration, or default to first (nearest)
  const maxPain = useMemo(() => {
    if (!allMaxPain || allMaxPain.length === 0) return undefined;
    
    if (selectedExpiration !== null) {
      return allMaxPain.find(mp => mp.expirationDays === selectedExpiration) || allMaxPain[0];
    }
    
    return allMaxPain[0]; // Default to nearest expiration
  }, [allMaxPain, selectedExpiration]);
  
  // Set default selection on mount
  useEffect(() => {
    if (allMaxPain && allMaxPain.length > 0 && selectedExpiration === null) {
      setSelectedExpiration(allMaxPain[0].expirationDays);
    }
  }, [allMaxPain, selectedExpiration]);
  
  // Debug: Log max pain data
  useEffect(() => {
    if (allMaxPain) {
      console.log('Max Pain Data:', allMaxPain.length, 'expirations found');
      allMaxPain.forEach(mp => {
        console.log(`  ${mp.expirationDays} days: $${mp.maxPainStrike.toFixed(2)}`);
      });
    }
  }, [allMaxPain]);
  
  const allChartData = useMemo(() => {
    const aggregated = aggregateDeltaByStrike(deltaData);
    
    // Convert to array and sort by strike
    const data = Array.from(aggregated.entries())
      .map(([strike, hedgingShares]) => ({
        strike,
        hedgingShares: Math.round(hedgingShares),
        // Positive = market makers need to buy (bullish pressure)
        // Negative = market makers need to sell (bearish pressure)
        buyPressure: hedgingShares > 0 ? hedgingShares : 0,
        sellPressure: hedgingShares < 0 ? Math.abs(hedgingShares) : 0,
      }))
      .sort((a, b) => a.strike - b.strike);

    return data;
  }, [deltaData]);

  // Calculate min/max strikes for slider (full range)
  const minStrike = useMemo(() => Math.min(...allChartData.map(d => d.strike)), [allChartData]);
  const maxStrike = useMemo(() => Math.max(...allChartData.map(d => d.strike)), [allChartData]);
  
  // Calculate initial zoom range: Max pain strike ± 20 strikes (or current price if no max pain)
  const initialZoomRange = useMemo(() => {
    if (allChartData.length === 0) {
      return [minStrike, maxStrike] as [number, number];
    }
    
    // Get all unique strikes, sorted
    const allStrikes = Array.from(new Set(allChartData.map(d => d.strike))).sort((a, b) => a - b);
    
    if (allStrikes.length === 0) {
      return [minStrike, maxStrike] as [number, number];
    }
    
    // Use max pain strike as center if available, otherwise use current price
    let centerStrike = optionsChain.spotPrice > 0 ? optionsChain.spotPrice : allStrikes[Math.floor(allStrikes.length / 2)];
    if (maxPain && maxPain.maxPainStrike > 0) {
      centerStrike = maxPain.maxPainStrike;
    }
    
    // Find the index of the center strike (or closest strike)
    let centerIndex = allStrikes.findIndex(s => s >= centerStrike);
    if (centerIndex === -1) {
      // If center strike is beyond all strikes, use the last strike
      centerIndex = allStrikes.length - 1;
    } else if (centerIndex > 0) {
      // If we found a strike >= center, check if previous strike is closer
      const prevDiff = Math.abs(allStrikes[centerIndex - 1] - centerStrike);
      const currDiff = Math.abs(allStrikes[centerIndex] - centerStrike);
      if (prevDiff < currDiff) {
        centerIndex = centerIndex - 1;
      }
    }
    
    // Calculate 20 strikes below and above
    const strikesBelow = 20;
    const strikesAbove = 20;
    
    const lowerIndex = Math.max(0, centerIndex - strikesBelow);
    const upperIndex = Math.min(allStrikes.length - 1, centerIndex + strikesAbove);
    
    const lowerBound = allStrikes[lowerIndex];
    const upperBound = allStrikes[upperIndex];
    
    return [lowerBound, upperBound] as [number, number];
  }, [allChartData, minStrike, maxStrike, maxPain, optionsChain.spotPrice]);
  
  // State for zoom range - start with 50% range around current price
  const [zoomRange, setZoomRange] = useState<[number, number]>(initialZoomRange);
  const [minInput, setMinInput] = useState<string>(initialZoomRange[0].toFixed(2));
  const [maxInput, setMaxInput] = useState<string>(initialZoomRange[1].toFixed(2));
  
  // Update zoom range when data changes - use dynamic calculation
  useEffect(() => {
    const newRange = initialZoomRange;
    setZoomRange(newRange);
    setMinInput(newRange[0].toFixed(2));
    setMaxInput(newRange[1].toFixed(2));
  }, [initialZoomRange]);
  
  // Sync inputs when zoom range changes from sliders
  useEffect(() => {
    setMinInput(zoomRange[0].toFixed(2));
    setMaxInput(zoomRange[1].toFixed(2));
  }, [zoomRange]);

  // Filter chart data based on zoom range
  const chartData = useMemo(() => {
    return allChartData.filter(d => d.strike >= zoomRange[0] && d.strike <= zoomRange[1]);
  }, [allChartData, zoomRange]);

  // Custom X-axis tick - hide tick if it's too close to current price
  const CustomXAxisTick = (props: any) => {
    const { x, y, payload } = props;
    const strikeValue = payload.value;
    
    // Hide tick if it's within 1% of current price to avoid overlap
    if (optionsChain.spotPrice > 0) {
      const priceDiff = Math.abs(strikeValue - optionsChain.spotPrice);
      const range = zoomRange[1] - zoomRange[0];
      if (priceDiff < range * 0.01) {
        return <g />;
      }
    }
    
    return (
      <g transform={`translate(${x},${y})`}>
        <text x={0} y={0} dy={16} textAnchor="middle" fill="#666" fontSize={10}>
          ${strikeValue.toFixed(0)}
        </text>
      </g>
    );
  };

  const totalBuyPressure = useMemo(() => {
    return chartData.reduce((sum, d) => sum + d.buyPressure, 0);
  }, [chartData]);

  const totalSellPressure = useMemo(() => {
    return chartData.reduce((sum, d) => sum + d.sellPressure, 0);
  }, [chartData]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      const symbol = optionsChain.ticker;
      return (
        <div className="bg-white p-4 border border-gray-300 rounded-lg shadow-lg">
          <p className="font-semibold">Strike: ${data.strike}</p>
          <p className="text-green-600">
            Buy Pressure: {data.buyPressure.toLocaleString()} {symbol}
          </p>
          <p className="text-red-600">
            Sell Pressure: {data.sellPressure.toLocaleString()} {symbol}
          </p>
          <p className="text-gray-600 text-sm mt-1">
            Net: {data.hedgingShares.toLocaleString()} {symbol}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="w-full space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-6 rounded-lg shadow-md">
          <h3 className="text-sm font-medium text-gray-500 mb-2">Current Price</h3>
          <p className="text-2xl font-bold text-gray-900">${optionsChain.spotPrice.toFixed(2)}</p>
        </div>
        {maxPain && (() => {
          const expirationDate = new Date();
          expirationDate.setDate(expirationDate.getDate() + maxPain.expirationDays);
          const formattedDate = expirationDate.toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric', 
            year: 'numeric' 
          });
          const hasMultipleExpirations = allMaxPain && allMaxPain.length > 1;
          
          return (
            <div className="bg-white p-6 rounded-lg shadow-md border-l-4 border-purple-500">
              <h3 className="text-sm font-medium text-gray-500 mb-1">Max Pain Strike</h3>
              <p className="text-3xl font-bold text-purple-600 mb-2">${maxPain.maxPainStrike.toFixed(2)}</p>
              {hasMultipleExpirations && allMaxPain ? (
                <div className="mb-2">
                  <label className="block text-xs text-gray-600 mb-1">Select Expiration:</label>
                  <select
                    value={selectedExpiration !== null ? selectedExpiration : (allMaxPain[0]?.expirationDays || maxPain.expirationDays)}
                    onChange={(e) => setSelectedExpiration(Number(e.target.value))}
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white font-medium"
                  >
                    {allMaxPain.map((mp) => {
                      const expDate = new Date();
                      expDate.setDate(expDate.getDate() + mp.expirationDays);
                      const dateStr = expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                      return (
                        <option key={mp.expirationDays} value={mp.expirationDays}>
                          {mp.expirationDays}d - {dateStr} - ${mp.maxPainStrike.toFixed(2)}
                        </option>
                      );
                    })}
                  </select>
                </div>
              ) : null}
              <div className="mt-2 pt-2 border-t border-gray-200">
                <p className="text-xs text-gray-600">
                  <span className="font-medium">Expires:</span> {formattedDate}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  <span className="font-medium">Days:</span> {maxPain.expirationDays}
                </p>
                {maxPain.totalOpenInterest !== undefined && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    <span className="font-medium">Open Interest:</span> {maxPain.totalOpenInterest.toLocaleString()} contracts
                    {maxPain.isReliable === false && (
                      <span className="text-yellow-600 ml-1">⚠️ Low data</span>
                    )}
                  </p>
                )}
              </div>
            </div>
          );
        })()}
        <div className="bg-white p-6 rounded-lg shadow-md border-l-4 border-green-500">
          <h3 className="text-sm font-medium text-gray-500 mb-2">Total Buy Pressure</h3>
          <p className="text-2xl font-bold text-green-600">
            {totalBuyPressure.toLocaleString()} {optionsChain.ticker}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Market makers need to buy if price rallies
          </p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow-md border-l-4 border-red-500">
          <h3 className="text-sm font-medium text-gray-500 mb-2">Total Sell Pressure</h3>
          <p className="text-2xl font-bold text-red-600">
            {totalSellPressure.toLocaleString()} {optionsChain.ticker}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Market makers need to sell if price drops
          </p>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-white p-6 rounded-lg shadow-md">
        <h2 className="text-xl font-bold mb-4">Delta Hedging Requirements by Strike</h2>
        <p className="text-sm text-gray-600 mb-6">
          Shows potential buying (green) and selling (red) pressure from market makers managing delta-neutral positions
        </p>
        
        {/* Zoom Controls */}
        <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-center justify-between mb-3">
            <label className="text-sm font-semibold text-gray-700">
              Zoom to Strike Range:
            </label>
            <button
              onClick={() => setZoomRange([minStrike, maxStrike])}
              className="px-3 py-1.5 text-xs bg-gray-200 hover:bg-gray-300 rounded transition-colors font-medium"
            >
              Reset to Full Range
            </button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
            {/* Min Strike Input */}
            <div>
              <label className="block text-xs text-gray-600 mb-1">Min Strike</label>
              <input
                type="text"
                value={minInput}
                onChange={(e) => {
                  setMinInput(e.target.value);
                  const inputValue = Number(e.target.value);
                  if (!isNaN(inputValue) && inputValue >= minStrike && inputValue < zoomRange[1]) {
                    setZoomRange([inputValue, zoomRange[1]]);
                  }
                }}
                onBlur={(e) => {
                  const inputValue = Number(e.target.value);
                  if (isNaN(inputValue) || inputValue < minStrike) {
                    setMinInput(minStrike.toFixed(2));
                    setZoomRange([minStrike, zoomRange[1]]);
                  } else if (inputValue >= zoomRange[1]) {
                    const newMin = zoomRange[1] - 0.01;
                    setMinInput(newMin.toFixed(2));
                    setZoomRange([newMin, zoomRange[1]]);
                  } else {
                    setMinInput(inputValue.toFixed(2));
                    setZoomRange([inputValue, zoomRange[1]]);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>
            
            {/* Range Slider */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-16">{minStrike.toFixed(0)}</span>
                <div className="flex-1 space-y-2">
                  <input
                    type="range"
                    min={minStrike}
                    max={maxStrike}
                    value={zoomRange[0]}
                    onChange={(e) => {
                      const newMin = Math.min(Number(e.target.value), zoomRange[1] - 1);
                      setZoomRange([newMin, zoomRange[1]]);
                    }}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-primary-600"
                  />
                  <input
                    type="range"
                    min={minStrike}
                    max={maxStrike}
                    value={zoomRange[1]}
                    onChange={(e) => {
                      const newMax = Math.max(Number(e.target.value), zoomRange[0] + 1);
                      setZoomRange([zoomRange[0], newMax]);
                    }}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-primary-600"
                  />
                </div>
                <span className="text-xs text-gray-500 w-16 text-right">{maxStrike.toFixed(0)}</span>
              </div>
            </div>
            
            {/* Max Strike Input */}
            <div>
              <label className="block text-xs text-gray-600 mb-1">Max Strike</label>
              <input
                type="text"
                value={maxInput}
                onChange={(e) => {
                  setMaxInput(e.target.value);
                  const inputValue = Number(e.target.value);
                  if (!isNaN(inputValue) && inputValue <= maxStrike && inputValue > zoomRange[0]) {
                    setZoomRange([zoomRange[0], inputValue]);
                  }
                }}
                onBlur={(e) => {
                  const inputValue = Number(e.target.value);
                  if (isNaN(inputValue) || inputValue > maxStrike) {
                    setMaxInput(maxStrike.toFixed(2));
                    setZoomRange([zoomRange[0], maxStrike]);
                  } else if (inputValue <= zoomRange[0]) {
                    const newMax = zoomRange[0] + 0.01;
                    setMaxInput(newMax.toFixed(2));
                    setZoomRange([zoomRange[0], newMax]);
                  } else {
                    setMaxInput(inputValue.toFixed(2));
                    setZoomRange([zoomRange[0], inputValue]);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>
          </div>
          
          <div className="mt-3 text-xs text-gray-500 text-center">
            Showing ${zoomRange[0].toFixed(2)} - ${zoomRange[1].toFixed(2)} 
            <span className="mx-2">•</span>
            {((zoomRange[1] - zoomRange[0]) / (maxStrike - minStrike) * 100).toFixed(1)}% of total range
          </div>
        </div>

        <ResponsiveContainer width="100%" height={500}>
          <BarChart data={chartData} margin={{ top: 20, right: 30, left: 50, bottom: 110 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="strike"
              type="number"
              domain={[zoomRange[0], zoomRange[1]]}
              label={{ 
                value: 'Strike Price ($)', 
                position: 'bottom', 
                offset: 20,
                angle: 0,
                dx: -200,
                style: { textAnchor: 'start' }
              }}
              tick={CustomXAxisTick}
              tickCount={8}
              tickFormatter={(value) => `$${value.toFixed(0)}`}
              interval="preserveStartEnd"
            />
            {optionsChain.spotPrice > 0 && (
              <ReferenceLine
                x={optionsChain.spotPrice}
                stroke="none"
                label={{
                  value: `✕`,
                  position: 'bottom',
                  offset: 12,
                  fill: '#3b82f6',
                  fontSize: 22,
                  fontWeight: 'bold'
                }}
                ifOverflow="visible"
              />
            )}
            {optionsChain.spotPrice > 0 && (
              <ReferenceLine
                x={optionsChain.spotPrice}
                stroke="none"
                label={{
                  value: `$${optionsChain.spotPrice.toFixed(2)}`,
                  position: 'bottom',
                  offset: 35,
                  fill: '#3b82f6',
                  fontSize: 12,
                  fontWeight: 'bold',
                }}
                ifOverflow="visible"
              />
            )}
            <YAxis
              label={{ 
                value: `${optionsChain.ticker} to Hedge`, 
                angle: -90, 
                position: 'insideLeft',
                offset: -5,
                style: { textAnchor: 'middle' }
              }}
              tick={{ fontSize: 12 }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend 
              wrapperStyle={{ paddingTop: '35px' }}
              verticalAlign="bottom"
              align="center"
            />
            {maxPain && (() => {
              const expirationDate = new Date();
              expirationDate.setDate(expirationDate.getDate() + maxPain.expirationDays);
              const formattedDate = expirationDate.toLocaleDateString('en-US', { 
                month: 'short', 
                day: 'numeric' 
              });
              
              // Check if prices are close together
              const priceDiff = optionsChain.spotPrice > 0 
                ? Math.abs(optionsChain.spotPrice - maxPain.maxPainStrike)
                : 0;
              const avgPrice = optionsChain.spotPrice > 0
                ? (optionsChain.spotPrice + maxPain.maxPainStrike) / 2
                : maxPain.maxPainStrike;
              const isClose = priceDiff < (avgPrice * 0.02);
              
              return (
                <ReferenceLine
                  x={maxPain.maxPainStrike}
                  stroke="#a855f7"
                  strokeDasharray="6 3"
                  strokeWidth={3}
                  label={{ 
                    value: `Max Pain: $${maxPain.maxPainStrike.toFixed(2)} (${formattedDate})`, 
                    position: isClose && optionsChain.spotPrice > 0 ? 'bottom' : 'top', 
                    fill: '#a855f7',
                    fontSize: 13,
                    fontWeight: 'bold',
                    offset: isClose && optionsChain.spotPrice > 0 ? 15 : 10,
                  }}
                />
              );
            })()}
            <Bar
              dataKey="buyPressure"
              fill="#10b981"
              name="Buy Pressure (Rally Hedge)"
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="sellPressure"
              fill="#ef4444"
              name="Sell Pressure (Drop Hedge)"
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Explanation */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-blue-900 mb-3">How to Read This Chart</h3>
        <ul className="space-y-2 text-sm text-blue-800">
          <li>
            <strong>Green bars:</strong> If the price rallies above this strike, market makers need to buy {optionsChain.ticker} to stay delta-neutral
          </li>
          <li>
            <strong>Red bars:</strong> If the price drops below this strike, market makers need to sell {optionsChain.ticker} to stay delta-neutral
          </li>
          <li>
            <strong>Blue X:</strong> Current spot price of {optionsChain.ticker} (marked on the price axis)
          </li>
          {maxPain && (
            <li>
              <strong>Purple line:</strong> Max Pain at ${maxPain.maxPainStrike} - The strike price where option holders would experience maximum loss at expiration ({maxPain.expirationDays} days). Market makers often push price toward this level.
            </li>
          )}
          <li>
            <strong>Key insight:</strong> Large concentrations of open interest at certain strikes create "gamma walls" where significant buying or selling pressure can emerge
          </li>
        </ul>
      </div>

      {/* Assumptions Disclaimer */}
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-yellow-900 mb-2">⚠️ Important Assumptions</h3>
        <ul className="space-y-1 text-xs text-yellow-800">
          <li>
            <strong>Open Interest Assumption:</strong> Applies a 60% multiplier to account for covered call sellers (who own stock and don't need hedging) and long positions. Automatically adjusts for stocks with high call/put ratios (more covered calls = lower hedging requirement).
          </li>
          <li>
            <strong>Market Maker Focus:</strong> Assumes market makers hold all short positions and hedge delta-neutral. Other participants (retail, institutions) also hold positions.
          </li>
          <li>
            <strong>Use for Relative Analysis:</strong> The absolute numbers are estimates. Focus on relative pressure (which strikes have more/less) rather than exact share counts.
          </li>
        </ul>
      </div>
    </div>
  );
}




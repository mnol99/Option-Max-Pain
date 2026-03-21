/**
 * API Route for fetching options data
 * Supports both cached and live data
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCachedOptionsChain, getCacheInfo } from '@/lib/data-cache';
import { normalizeTicker } from '@/lib/ticker-aliases';

export const dynamic = 'force-dynamic'; // Ensure this route is dynamic

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  try {
    const { ticker } = await params;
    const normalizedTicker = normalizeTicker(ticker);
    const searchParams = request.nextUrl.searchParams;
    const live = searchParams.get('live') === 'true';
    const forceRefresh = searchParams.get('refresh') === 'true' || live;

    const data = await getCachedOptionsChain(normalizedTicker, forceRefresh);
    const cacheInfo = getCacheInfo(normalizedTicker);

    return NextResponse.json({
      success: true,
      data,
      cache: cacheInfo,
      live,
    });
  } catch (error) {
    // Only log error once, not repeatedly
    const errorMessage = error instanceof Error ? error.message : 'Failed to fetch options data';
    const isAuthError = errorMessage.includes('invalid') || errorMessage.includes('unauthorized') || errorMessage.includes('403') || errorMessage.includes('401');
    
    // Don't log auth errors repeatedly - they're expected when no API keys are set
    if (!isAuthError) {
      console.error('Error fetching options data:', errorMessage);
    }
    
    // Fallback to mock data on any error
    try {
      const { ticker: tickerParam } = await params;
      const { fetchOptionsChain } = await import('@/lib/options-api');
      const mockData = await fetchOptionsChain(normalizeTicker(tickerParam));
      
      // If it's an auth error, provide helpful guidance (but only show once)
      if (isAuthError) {
        let warningMessage = 'No API keys configured or keys are invalid. Showing mock data.';
        
        // Check if it's a Polygon.io subscription issue
        if (errorMessage.includes('free tier') || errorMessage.includes('subscription') || errorMessage.includes('plan')) {
          warningMessage = 'Polygon.io free tier does not include options data. Showing mock data. For free options data, try MarketData.app - see POLYGON_OPTIONS_LIMITATION.md';
        } else {
          warningMessage = 'No API keys configured or keys are invalid. Showing mock data. See README_API_KEYS.md for setup instructions.';
        }
        
        return NextResponse.json(
          {
            success: true, // Mark as success since we have mock data
            data: mockData,
            cache: null,
            live: false,
            usingMockData: true,
            warning: warningMessage,
          },
          { status: 200 }
        );
      }
      
      return NextResponse.json(
        {
          success: true, // Mark as success since we have mock data
          data: mockData,
          cache: null,
          live: false,
          usingMockData: true,
          warning: 'Using mock data due to API error.',
        },
        { status: 200 }
      );
    } catch (mockError) {
      // Even mock data failed
      console.error('Failed to generate mock data:', mockError);
      return NextResponse.json(
        {
          success: false,
          error: errorMessage,
        },
        { status: 500 }
      );
    }
  }
}


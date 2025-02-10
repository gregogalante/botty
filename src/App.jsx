import { useState, useRef, useEffect, useMemo } from 'react'
import * as SolanaWeb3 from '@solana/web3.js'
import * as PythNetworkClient from '@pythnetwork/client'
import * as Rechart from 'recharts'

// CONSTANTS
////////////////////////////////////////////////////////////////////////

const PRICE_HISTORY_LOCAL_STORAGE_KEY = 'priceHistory'
const TRADE_HISTORY_LOCAL_STORAGE_KEY = 'tradeHistory'
const TRADE_LOCAL_STORAGE_KEY = 'trade'

const USD_INVESTMENT = 200

const MIN_PERC_PROFIT_TO_CLOSE = 0.01
const MIN_USD_PROFIT_TO_CLOSE = 0.50

const TRENDS_DOWN_TO_OPEN = [15, 30, 45]
const TRENDS_UP_TO_CLOSE = []

const MAX_PRICE_HISTORY_SIZE = 1000

let RUN_OPERATIONS_SEMAPHORE = false

// HELPER FUNCTIONS
////////////////////////////////////////////////////////////////////////

function getDefaultPriceHistory() {
  const priceHistoryStr = localStorage.getItem(PRICE_HISTORY_LOCAL_STORAGE_KEY)
  return priceHistoryStr ? JSON.parse(priceHistoryStr) : []
}

function getDefaultTradeHistory() {
  const tradeHistoryStr = localStorage.getItem(TRADE_HISTORY_LOCAL_STORAGE_KEY)
  return tradeHistoryStr ? JSON.parse(tradeHistoryStr) : []
}

function getDefaultTrade() {
  const tradeStr = localStorage.getItem(TRADE_LOCAL_STORAGE_KEY)
  return tradeStr ? JSON.parse(tradeStr) : null
}

function calculateTradeProfit(trade, forcedClosePrice = null) {
  const openPrice = trade.avgOpenPrice
  const closePrice = forcedClosePrice || trade.avgClosePrice
  const quantity = trade.quantity

  return (closePrice - openPrice) * quantity
}

function calculateTradeDuration(trade) {
  let openTime = new Date(trade.openTime)
  let closeTime = trade.closeTime ? new Date(trade.closeTime) : new Date()

  return (closeTime - openTime) / 1000
}

/**
 * This function should identify the price trend based on the price history.
 * It should return a string 'up', 'down', or 'sideways'.
 * - up: The price is increasing in the last N seconds.
 * - down: The price is decreasing in the last N seconds.
 * - sideways: The price is not increasing or decreasing in the last N seconds.
 * @param {Array} priceHistory
 * @param {Date} priceHistory[].time
 * @param {Number} priceHistory[].price
 * @param {Number} minPercentChange
 * @param {Number} seconds
 */
function identifyTrend(priceHistory, minPercentChange, seconds) {
  if (!priceHistory || !priceHistory.length) {
    return 'sideways'
  }

  // Sort price history by time in ascending order
  const sortedHistory = [...priceHistory].sort((a, b) => a.time - b.time)
  
  // Get the current time from the latest entry
  const currentTime = new Date(sortedHistory[sortedHistory.length - 1].time)

  // Filter prices within the specified time window
  const cutoffTime = new Date(currentTime.getTime() - seconds * 1000)
  const relevantPrices = sortedHistory.filter(entry => entry.time >= cutoffTime)

  if (relevantPrices.length < 2) {
    return 'sideways'
  }

  // Get first and last prices in the time window
  const firstPrice = relevantPrices[0].price
  const lastPrice = relevantPrices[relevantPrices.length - 1].price

  // Calculate percentage change
  const percentChange = ((lastPrice - firstPrice) / firstPrice) * 100

  // Determine trend based on percent change threshold
  if (Math.abs(percentChange) < minPercentChange) {
    return 'sideways'
  }

  return percentChange > 0 ? 'up' : 'down'
}

async function runOperations(priceHistory, trade) {
  if (RUN_OPERATIONS_SEMAPHORE) return
  RUN_OPERATIONS_SEMAPHORE = true

  const currentPrice = priceHistory[priceHistory.length - 1]

  if (trade) { // Choose to close trade
    const lastTrends = TRENDS_UP_TO_CLOSE.map(seconds => identifyTrend(priceHistory, 0.01, seconds))

    if (lastTrends.some(trend => trend !== 'up')) {
      RUN_OPERATIONS_SEMAPHORE = false
      return
    }

    // be sure there is a profit of at least MIN_PERC_PROFIT_TO_CLOSE and MIN_USD_PROFIT_TO_CLOSE
    const profit = calculateTradeProfit(trade, currentPrice.price)
    const profitPercentage = (profit / trade.avgOpenPrice) * 100
    console.log(`Profit: ${profit.toFixed(4)}$ (${(profitPercentage).toFixed(2)}%)`)
    if (profit < MIN_USD_PROFIT_TO_CLOSE || profitPercentage < MIN_PERC_PROFIT_TO_CLOSE) {
      RUN_OPERATIONS_SEMAPHORE = false
      return
    }

    // simulate waiting for 5 seconds before closing the trade
    await new Promise(resolve => setTimeout(resolve, 5000))

    RUN_OPERATIONS_SEMAPHORE = false
    return { type: 'close', closePrice: currentPrice, closeTime: new Date().getTime() }
  } else { // Choose to open trade
    const lastTrends = TRENDS_DOWN_TO_OPEN.map(seconds => identifyTrend(priceHistory, 0.01, seconds))

    if (lastTrends.some(trend => trend !== 'down')) {
      RUN_OPERATIONS_SEMAPHORE = false
      return
    }

    // calculate quantity as USD_INVESTMENT / currentPrice.price
    const quantity = USD_INVESTMENT / currentPrice.price

    // simulate waiting for 5 seconds before opening the trade
    await new Promise(resolve => setTimeout(resolve, 5000))
    
    RUN_OPERATIONS_SEMAPHORE = false
    return { type: 'open', openPrice: currentPrice, openTime: new Date().getTime(), quantity: quantity }
  }
}

// REACT APP
////////////////////////////////////////////////////////////////////////

function App() {
  const runInterval = useRef(true)

  const [status, setStatus] = useState(false)
  const statusRef = useRef(status)

  const [priceHistory, setPriceHistory] = useState(getDefaultPriceHistory())
  const priceHistoryRef = useRef(priceHistory)

  const [tradeHistory, setTradeHistory] = useState(getDefaultTradeHistory())
  const tradeHistoryRef = useRef(tradeHistory)

  const [trade, setTrade] = useState(getDefaultTrade())
  const tradeRef = useRef(trade)

  const lastOtherPrices = useRef({ btc: null, eth: null })

  const forceCloseTrade = () => {
    if (!tradeRef.current) return

    const confirmation = window.confirm('Are you sure you want to force close the trade?')
    if (!confirmation) return

    const operation = { type: 'close', closePrice: priceHistoryRef.current[priceHistoryRef.current.length - 1], closeTime: new Date().getTime() }
    applyOperation(operation)
  }

  const forceClearTradeHistory = () => {
    const confirmation = window.confirm('Are you sure you want to clear all trade history?')
    if (!confirmation) return

    runInterval.current = false
    setTimeout(() => {
      localStorage.removeItem(TRADE_HISTORY_LOCAL_STORAGE_KEY)
      window.location.reload()
    }, 1000)
  }

  const applyOperation = (operation) => {
    if (!tradeRef.current && operation.type === 'open') {
      operation.afterOpenPrice = priceHistoryRef.current[priceHistoryRef.current.length - 1]
      operation.avgOpenPrice = (operation.openPrice.price + operation.afterOpenPrice.price) / 2
      tradeRef.current = operation
    } else if (tradeRef.current && operation.type === 'close') {
      tradeRef.current = { ...tradeRef.current, ...operation }
      tradeRef.current.afterClosePrice = priceHistoryRef.current[priceHistoryRef.current.length - 1]
      tradeRef.current.avgClosePrice = (tradeRef.current.closePrice.price + tradeRef.current.afterClosePrice.price) / 2
      tradeHistoryRef.current.push(tradeRef.current)
      tradeRef.current = null
    }
  }

  useEffect(() => {
    const connection = new SolanaWeb3.Connection(PythNetworkClient.getPythClusterApiUrl('pythnet'))
    const pythPublicKey = PythNetworkClient.getPythProgramKeyForCluster('pythnet')
    const feeds = [
      new SolanaWeb3.PublicKey('H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG')
    ]

    const pythConnection = new PythNetworkClient.PythConnection(connection, pythPublicKey, 'confirmed', feeds)
    pythConnection.onPriceChangeVerbose(async (productAccount, priceAccount) => {
      const price = priceAccount.accountInfo.data
      if (price.price && price.confidence) {
        priceHistoryRef.current.push({ time: (new Date()).getTime(), price: price.price, confidence: parseFloat(price.confidence.toFixed(4)), btc: lastOtherPrices.current.btc, eth: lastOtherPrices.current.eth })
        if (priceHistoryRef.current.length > MAX_PRICE_HISTORY_SIZE) priceHistoryRef.current.shift()

        // run operations based on data
        if (statusRef.current) {
          const operation = await runOperations(priceHistoryRef.current, tradeRef.current)
          if (operation) applyOperation(operation)
        }

        // update current trade best and worst price
        if (tradeRef.current && tradeRef.current.type === 'open') {
          tradeRef.current.bestPrice = Math.max(tradeRef.current.bestPrice || 0, price.price)
          tradeRef.current.worstPrice = Math.min(tradeRef.current.worstPrice || price.price, price.price) 
        }
      }
    })

    pythConnection.start()

    return () => {
      pythConnection.stop()
    }
  }, [])

  useEffect(() => {
    const priceIds = {
      btc: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'.toLowerCase(),
      eth: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace'.toLowerCase(),
    }

    const loadOtherPrices = async () => {
      try {
        const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${priceIds.btc}&ids[]=${priceIds.eth}`
        const response = await fetch(url)
        const data = await response.json()
        let btcPrice = data.parsed.find(item => '0x' + item.id.toLowerCase() == priceIds.btc)?.price?.price
        let ethPrice = data.parsed.find(item => '0x' + item.id.toLowerCase() == priceIds.eth)?.price?.price
        if (btcPrice) btcPrice = parseFloat(btcPrice) / 100000000
        if(ethPrice) ethPrice = parseFloat(ethPrice) / 100000000
        lastOtherPrices.current = { btc: btcPrice || lastOtherPrices.current.btc, eth: ethPrice || lastOtherPrices.current.eth }  
      } catch (error) {
        console.error(error)
      }

      await new Promise(resolve => setTimeout(resolve, 2500))
      loadOtherPrices()
    }
    loadOtherPrices()
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      if (!runInterval.current) return

      setPriceHistory([...priceHistoryRef.current])
      localStorage.setItem(PRICE_HISTORY_LOCAL_STORAGE_KEY, JSON.stringify(priceHistoryRef.current))

      setTradeHistory([...tradeHistoryRef.current])
      localStorage.setItem(TRADE_HISTORY_LOCAL_STORAGE_KEY, JSON.stringify(tradeHistoryRef.current))

      setTrade(tradeRef.current)
      localStorage.setItem(TRADE_LOCAL_STORAGE_KEY, JSON.stringify(tradeRef.current))

      setStatus(statusRef.current)
    }, 1000)

    return () => {
      clearInterval(interval)
    }
  }, [])

  const lastPrice = useMemo(() => {
    const price = priceHistory[priceHistory.length - 1]
    if (!price) return null

    const trendsSeconds = TRENDS_DOWN_TO_OPEN.concat(TRENDS_UP_TO_CLOSE).sort((a, b) => a - b).filter((value, index, self) => self.indexOf(value) === index)
    
    price.lastTrends = trendsSeconds.map(seconds => ({
      seconds,
      trend: identifyTrend(priceHistory, 0.01, seconds)
    }))

    return price
  }, [priceHistory])

  const chartData = useMemo(() => {
    if (!trade) return priceHistory

    return priceHistory.concat([{
      time: trade.openTime,
      price: trade.avgOpenPrice,
      trade: trade.avgOpenPrice,
      confidence: 1
    }]).sort((a, b) => a.time - b.time)
  }, [priceHistory, trade])

  return (
    <div className='bg-gray-600 w-screen min-h-screen flex flex-col p-6 overflow-y-auto'>
      <div className='card flex justify-between items-center'>
        <h1 className='text-xl font-bold'>Solana Trading Bot</h1>

        <button
          className={`${status ? 'btn-red' : 'btn-green'}`}
          onClick={() => statusRef.current = !statusRef.current}
        >
          {status ? 'Stop' : 'Start'}
        </button>
      </div>

      <div className='card w-full h-[400px]'>
        <Rechart.ResponsiveContainer width='100%' height='100%'>
          <Rechart.LineChart data={chartData}>
            <Rechart.CartesianGrid strokeDasharray='3 3' />
            <Rechart.XAxis
              dataKey='time'
              tickFormatter={(time) => new Date(time).toLocaleTimeString()}
            />
            <Rechart.YAxis 
              yAxisId="price"
              domain={['auto', 'auto']} 
              color='#2980b9'
              stroke='#2980b9'
            />
            <Rechart.YAxis 
              yAxisId="priceBtc"
              domain={['auto', 'auto']} 
              orientation="right"
              color='#f39c12'
              stroke='#f39c12'
            />
            <Rechart.YAxis 
              yAxisId="priceEth"
              domain={['auto', 'auto']}
              orientation="right"
              color='#7f8c8d'
              stroke='#7f8c8d'
            />
            <Rechart.Tooltip
              formatter={(value, name, props) => {
                if (name === 'price') return `${value.toFixed(4)}$`
                if (name === 'confidence') return `${(value * 100).toFixed(2)}%`
                if (name === 'trade') return `${value.toFixed(4)}$`
                if (name === 'btc') return `${value.toFixed(2)}$`
                if (name === 'eth') return `${value.toFixed(2)}$`
              }}
              labelFormatter={(label) => new Date(label).toLocaleTimeString()}
            />
            <Rechart.Line type='monotone' dataKey='trade' stroke='red' yAxisId="price" isAnimationActive={false} />
            <Rechart.Line type='monotone' dataKey='price' stroke='#2980b9' yAxisId="price" isAnimationActive={false} dot={false} strokeWidth={2} />
            <Rechart.Line type='monotone' dataKey='btc' stroke='#f39c12' yAxisId="priceBtc" isAnimationActive={false} dot={false} />
            <Rechart.Line type='monotone' dataKey='eth' stroke='#7f8c8d' yAxisId="priceEth" isAnimationActive={false} dot={false} />

            {/** Draw trade horizontal line */}
            {trade && (
              <Rechart.ReferenceLine
                y={trade.avgOpenPrice}
                stroke='red'
                strokeDasharray='3 3'
                yAxisId="price"
              />
            )}
          </Rechart.LineChart>
        </Rechart.ResponsiveContainer>
      </div>
      {lastPrice && (
        <div className='card'>
          <h2 className='card-title'>Last Price</h2>
          <div className='card-data'>
            <div className='card-data-item'>
              <div>Price</div>
              <div>{lastPrice.price.toFixed(4)}$</div>
            </div>
            <div className='card-data-item'>
              <div>Confidence</div>
              <div>{(lastPrice.confidence * 100).toFixed(2)}%</div>
            </div>
            {lastPrice.lastTrends.map((trend, index) => (
              <div key={index} className='card-data-item'>
                <div>Last {trend.seconds} sec trend</div>
                <div
                  className={trend.trend == 'sideways' ? 'text-gray-500' : (trend.trend == 'up' ? (trade ? 'text-green-500' : 'text-red-500') : (trade ? 'text-red-500' : 'text-green-500'))}
                >{trend.trend}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {trade && (
        <div className='card'>
          <h2 className='card-title'>Trade</h2>
          <div className='card-data'>
            <div className='card-data-item'>
              <div>AVG Open price</div>
              <div>{trade.avgOpenPrice.toFixed(4)}$</div>
            </div>

            <div className='card-data-item'>
              <div>Duration</div>
              <div>{calculateTradeDuration(trade).toFixed(0)}s</div>
            </div>

            <div className='card-data-item'>
              <div>Quantity</div>
              <div>{trade.quantity.toFixed(4)}</div>
            </div>

            <div className='card-data-item'>
              <div>Price diff</div>
              <div>{(lastPrice.price - trade.avgOpenPrice).toFixed(4)}$</div>
            </div>

            <div className='card-data-item'>
              <div>Profit</div>
              <div>{calculateTradeProfit(trade, lastPrice.price).toFixed(4)}$</div>
            </div>

            <div className='card-data-item'>
              <div>Best price</div>
              <div>{trade.bestPrice ? trade.bestPrice.toFixed(4) : 'N/A'}$</div>
            </div>

            <div className='card-data-item'>
              <div>Worst price</div>
              <div>{trade.worstPrice ? trade.worstPrice.toFixed(4) : 'N/A'}$</div>
            </div>
          </div>

          <div className='flex justify-end items-center mt-4'>
            <button
              className='btn'
              onClick={forceCloseTrade}
            >
              Force Close
            </button>
          </div>
        </div>
      )}

      <div className='card'>
        <h2 className='card-title'>Trade History</h2>
        <table className='w-full text-center'>
          <thead className='bg-gray-800 text-white'>
            <tr>
              <th className='py-2'>Quantity</th>
              <th className='py-2'>AVG Open price</th>
              <th className='py-2'>AVG Close price</th>
              <th className='py-2'>Duration</th>
              <th className='py-2'>Profit</th>
            </tr>
          </thead>
          <tbody>
            {tradeHistory.map((trade, index) => (
              <tr key={index} className={`${calculateTradeProfit(trade) > 0 ? 'text-green-500' : 'text-red-500'} border-b border-gray-400`}>
                <td className='py-2'>{trade.quantity.toFixed(4)}</td>
                <td className='py-2'>${trade.avgOpenPrice.toFixed(4)}</td>
                <td className='py-2'>${trade.avgClosePrice.toFixed(4)}</td>
                <td className='py-2'>{calculateTradeDuration(trade).toFixed(0)}s</td>
                <td className='py-2'>${calculateTradeProfit(trade).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className='bg-gray-800 text-white'>
              <td></td>
              <td></td>
              <td></td>
              <td></td>
              <td>{tradeHistory.reduce((acc, trade) => acc + calculateTradeProfit(trade), 0).toFixed(4)}$</td>
            </tr>
          </tfoot>
        </table>

        <div className='flex justify-end items-center mt-4'>
          <button
            className='btn'
            onClick={forceClearTradeHistory}
          >
            Clear trade history
          </button>
        </div>
      </div>
    </div>
  )
}

export default App

import './App.css'

function App() {
  return (
    <main className="dashboard-shell">
      <iframe
        className="dashboard-frame"
        src="http://localhost:3001/d/dse855-scada/dse-855-scada?orgId=1&from=now-15m&to=now&timezone=browser&refresh=10s&kiosk"
        title="Grafana Dashboard"
      />
    </main>
  );
}

export default App

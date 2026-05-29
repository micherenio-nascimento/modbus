import './App.css'

function App() {
  return (
    <main className="dashboard-shell">
      <iframe
        className="dashboard-frame"
        src="http://18.191.242.141:3001/d/dse855-scada/dse-855-scada?orgId=1&from=now-5m&to=now&timezone=browser&refresh=5s&kiosk"
        title="Grafana Dashboard"
      />
    </main>
  );
}

export default App

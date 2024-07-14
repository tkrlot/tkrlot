<script>
    // Function to fetch weather temperature (example)
    function fetchWeather() {
        // Simulated temperature (replace with actual API call)
        const temperature = '25°C';

        // Update temperature in the DOM
        document.getElementById('weather-temp').textContent = temperature;
    }

    // Call fetchWeather() when the page loads (for demonstration)
    window.addEventListener('load', fetchWeather);
</script>
